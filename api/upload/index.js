const { SearchClient, SearchIndexClient, AzureKeyCredential } = require('@azure/search-documents');
const OpenAI = require('openai');
const pdf = require('pdf-parse');

// ============================================
// CONFIGURATION
// ============================================

const INDEX_NAME = 'documents';
const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 200;

// ============================================
// INDEX SCHEMA
// ============================================

const indexSchema = {
    name: INDEX_NAME,
    fields: [
        { name: 'id', type: 'Edm.String', key: true, searchable: false },
        { name: 'content', type: 'Edm.String', searchable: true, analyzerName: 'standard.lucene' },
        {
            name: 'embedding',
            type: 'Collection(Edm.Single)',
            searchable: true,
            vectorSearchDimensions: 1536,
            vectorSearchProfileName: 'default-profile'
        },
        { name: 'filename', type: 'Edm.String', searchable: true, filterable: true },
        { name: 'chunkIndex', type: 'Edm.Int32', filterable: true },
        { name: 'uploadedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true }
    ],
    vectorSearch: {
        algorithms: [{
            name: 'default-algorithm',
            kind: 'hnsw',
            hnswParameters: { metric: 'cosine' }
        }],
        profiles: [{
            name: 'default-profile',
            algorithmConfigurationName: 'default-algorithm'
        }]
    }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

async function ensureIndexExists(indexClient) {
    try {
        await indexClient.getIndex(INDEX_NAME);
        console.log('Index already exists');
    } catch (error) {
        if (error.statusCode === 404) {
            console.log('Creating index...');
            await indexClient.createIndex(indexSchema);
            console.log('Index created');
        } else {
            throw error;
        }
    }
}

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        let end = start + chunkSize;

        // Try to break at sentence boundary
        if (end < text.length) {
            const lastPeriod = text.lastIndexOf('.', end);
            if (lastPeriod > start + chunkSize / 2) {
                end = lastPeriod + 1;
            }
        }

        chunks.push(text.slice(start, end).trim());
        start = end - overlap;
    }

    return chunks.filter(chunk => chunk.length > 20); // Filter out very tiny chunks
}

async function getEmbedding(openai, text) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
    });
    return response.data[0].embedding;
}

async function parsePDF(buffer) {
    const data = await pdf(buffer);
    return data; // Returns { text, numpages, info, etc. }
}

// ============================================
// AZURE FUNCTION HANDLER
// ============================================

module.exports = async function (context, req) {
    const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const searchKey = process.env.AZURE_SEARCH_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!searchEndpoint || !searchKey || !openaiApiKey) {
        context.res = {
            status: 500,
            body: { error: 'Missing configuration. Set AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_KEY, OPENAI_API_KEY' }
        };
        return;
    }

    const credential = new AzureKeyCredential(searchKey);
    const indexClient = new SearchIndexClient(searchEndpoint, credential);
    const searchClient = new SearchClient(searchEndpoint, INDEX_NAME, credential);
    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Ensure index exists
    try {
        await ensureIndexExists(indexClient);
    } catch (error) {
        context.res = {
            status: 500,
            body: { error: 'Failed to initialize search index: ' + error.message }
        };
        return;
    }

    // Handle different operations
    const operation = req.query.op || 'upload';

    if (operation === 'list') {
        // List all documents
        try {
            const results = await searchClient.search('*', {
                select: ['filename', 'uploadedAt'],
                top: 100
            });

            const files = new Map();
            for await (const result of results.results) {
                if (!files.has(result.document.filename)) {
                    files.set(result.document.filename, result.document.uploadedAt);
                }
            }

            context.res = {
                body: {
                    documents: Array.from(files.entries()).map(([name, date]) => ({
                        filename: name,
                        uploadedAt: date
                    }))
                }
            };
        } catch (error) {
            context.res = {
                status: 500,
                body: { error: error.message }
            };
        }
        return;
    }

    if (operation === 'upload') {
        // Upload document
        if (req.method !== 'POST') {
            context.res = {
                status: 405,
                body: { error: 'POST method required for upload' }
            };
            return;
        }

        try {
            const contentType = req.headers['content-type'] || '';
            let text = '';
            let filename = 'document.txt';

            console.log('Content-Type:', contentType);
            console.log('Body type:', typeof req.body);
            console.log('Body length:', req.body ? req.body.length : 0);

            if (contentType.includes('application/pdf')) {
                // Handle PDF upload
                try {
                    const buffer = Buffer.from(req.body);
                    console.log('PDF buffer size:', buffer.length);
                    const pdfData = await parsePDF(buffer);
                    text = pdfData.text || '';
                    console.log('Extracted PDF text length:', text.length);
                } catch (pdfError) {
                    console.error('PDF parsing error:', pdfError.message);
                    context.res = {
                        status: 400,
                        body: { error: 'Failed to parse PDF: ' + pdfError.message + '. Try uploading a text file instead.' }
                    };
                    return;
                }
                filename = req.query.filename || 'document.pdf';
            } else if (contentType.includes('application/json')) {
                // Handle JSON with text content
                const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                text = body.content || '';
                filename = body.filename || 'document.txt';
                console.log('JSON content length:', text.length);
            } else {
                // Handle plain text
                text = typeof req.body === 'string' ? req.body : (req.body ? req.body.toString() : '');
                filename = req.query.filename || 'document.txt';
                console.log('Plain text length:', text.length);
            }

            // Clean up text
            text = text.replace(/\s+/g, ' ').trim();
            console.log('Cleaned text length:', text.length);
            console.log('First 200 chars:', text.substring(0, 200));

            if (!text || text.length < 10) {
                context.res = {
                    status: 400,
                    body: { error: 'No content to index' }
                };
                return;
            }

            // Chunk the text
            const chunks = chunkText(text);
            console.log(`Text length: ${text.length}, Chunks: ${chunks.length}`);

            if (chunks.length === 0) {
                // If no chunks, treat entire text as one chunk
                chunks.push(text.substring(0, 5000)); // Limit to 5000 chars
            }

            // Generate embeddings and prepare documents
            const documents = [];
            const timestamp = new Date().toISOString();

            for (let i = 0; i < chunks.length; i++) {
                const chunkText = chunks[i];
                if (!chunkText || chunkText.trim().length < 10) continue;

                const embedding = await getEmbedding(openai, chunkText);
                documents.push({
                    id: `${filename.replace(/[^a-zA-Z0-9]/g, '_')}_${i}_${Date.now()}`,
                    content: chunkText,
                    embedding: embedding,
                    filename: filename,
                    chunkIndex: i,
                    uploadedAt: timestamp
                });
            }

            if (documents.length === 0) {
                context.res = {
                    status: 400,
                    body: { error: 'No valid content chunks to index. Text may be too short or empty.' }
                };
                return;
            }

            // Upload to Azure Search
            await searchClient.uploadDocuments(documents);

            context.res = {
                body: {
                    success: true,
                    filename: filename,
                    chunks: chunks.length,
                    message: `Indexed ${chunks.length} chunks from ${filename}`
                }
            };

        } catch (error) {
            context.res = {
                status: 500,
                body: { error: 'Upload failed: ' + error.message }
            };
        }
        return;
    }

    if (operation === 'delete') {
        // Delete document by filename
        const filename = req.query.filename;
        if (!filename) {
            context.res = {
                status: 400,
                body: { error: 'filename parameter required' }
            };
            return;
        }

        try {
            // Find all chunks for this file
            const results = await searchClient.search('*', {
                filter: `filename eq '${filename}'`,
                select: ['id'],
                top: 1000
            });

            const docsToDelete = [];
            for await (const result of results.results) {
                docsToDelete.push({ id: result.document.id });
            }

            if (docsToDelete.length > 0) {
                await searchClient.deleteDocuments(docsToDelete);
            }

            context.res = {
                body: {
                    success: true,
                    deleted: docsToDelete.length,
                    filename: filename
                }
            };
        } catch (error) {
            context.res = {
                status: 500,
                body: { error: error.message }
            };
        }
        return;
    }

    context.res = {
        status: 400,
        body: { error: 'Invalid operation. Use: upload, list, or delete' }
    };
};
