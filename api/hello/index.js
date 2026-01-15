const OpenAI = require('openai');
const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');
const fs = require('fs');
const path = require('path');

// ============================================
// PROMPT LOADER (supports local + Azure Blob)
// ============================================

class PromptLoader {
    constructor() {
        this.cache = null;
        this.cacheTime = 0;
        this.cacheTTL = 60000; // 1 minute cache
    }

    async load() {
        if (this.cache && (Date.now() - this.cacheTime) < this.cacheTTL) {
            return this.cache;
        }

        let promptConfig;

        if (process.env.PROMPT_BLOB_URL) {
            try {
                const response = await fetch(process.env.PROMPT_BLOB_URL);
                if (response.ok) {
                    promptConfig = await response.json();
                }
            } catch (error) {
                console.warn('Failed to load from Blob:', error.message);
            }
        }

        if (!promptConfig) {
            const localPath = path.join(__dirname, '..', 'prompts', 'search-agent.json');
            const fileContent = fs.readFileSync(localPath, 'utf-8');
            promptConfig = JSON.parse(fileContent);
        }

        this.cache = promptConfig;
        this.cacheTime = Date.now();
        return promptConfig;
    }

    render(template, variables) {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return variables[key] !== undefined ? variables[key] : match;
        });
    }
}

const promptLoader = new PromptLoader();

// ============================================
// RAG SEARCH (Azure AI Search)
// ============================================

class RAGSearch {
    constructor(endpoint, key, indexName = 'documents') {
        this.client = new SearchClient(endpoint, indexName, new AzureKeyCredential(key));
        this.openai = null;
    }

    setOpenAI(openai) {
        this.openai = openai;
    }

    async getEmbedding(text) {
        const response = await this.openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text
        });
        return response.data[0].embedding;
    }

    async search(query, topK = 5) {
        try {
            // Get query embedding for vector search
            const queryEmbedding = await this.getEmbedding(query);

            // Hybrid search (vector + keyword)
            const results = await this.client.search(query, {
                vectorSearchOptions: {
                    queries: [{
                        kind: 'vector',
                        vector: queryEmbedding,
                        fields: ['embedding'],
                        kNearestNeighborsCount: topK
                    }]
                },
                select: ['content', 'filename', 'chunkIndex'],
                top: topK
            });

            const documents = [];
            for await (const result of results.results) {
                documents.push({
                    content: result.document.content,
                    filename: result.document.filename,
                    score: result.score
                });
            }

            return documents;
        } catch (error) {
            console.error('RAG search error:', error.message);
            return [];
        }
    }

    async hasDocuments() {
        try {
            const results = await this.client.search('*', { top: 1 });
            for await (const _ of results.results) {
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }
}

// ============================================
// TOOLS (Agentic capabilities)
// ============================================

const tools = {
    webSearch: async (query, tavilyApiKey) => {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: tavilyApiKey,
                query: query,
                search_depth: 'basic',
                max_results: 5
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Search failed');
        }

        return response.json();
    },

    formatSearchContext: (results) => {
        return results
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nURL: ${r.url}`)
            .join('\n\n');
    },

    formatRAGContext: (documents) => {
        return documents
            .map((d, i) => `[DOC ${i + 1}] (${d.filename})\n${d.content}`)
            .join('\n\n');
    },

    shouldSearch: (message, chatHistory, searchBehavior) => {
        if (chatHistory.length === 0) return true;

        const lowerMessage = message.toLowerCase();

        if (searchBehavior.explicitTriggers.some(trigger => lowerMessage.includes(trigger))) {
            return true;
        }

        if (searchBehavior.followUpIndicators.some(indicator => lowerMessage.includes(indicator))) {
            return false;
        }

        if (message.split(' ').length <= searchBehavior.maxShortQuestionWords && message.includes('?')) {
            return false;
        }

        return true;
    },

    shouldUseRAG: (message) => {
        const lowerMessage = message.toLowerCase();

        // Explicit RAG triggers
        const ragTriggers = [
            'document', 'docs', 'uploaded', 'my files', 'my documents',
            'in the pdf', 'in the file', 'according to', 'based on the',
            'from the document', 'internal', 'our documentation'
        ];

        // Web search indicators (prefer web)
        const webIndicators = [
            'latest', 'news', 'current', 'today', 'recent',
            'who is', 'what is happening', 'search the web'
        ];

        if (webIndicators.some(indicator => lowerMessage.includes(indicator))) {
            return false;
        }

        if (ragTriggers.some(trigger => lowerMessage.includes(trigger))) {
            return true;
        }

        // Default: try RAG first if documents exist, fall back to web
        return null; // null means "try both"
    }
};

// ============================================
// AGENT CLASS
// ============================================

class ConversationalAgent {
    constructor(openaiClient, config, prompts) {
        this.client = openaiClient;
        this.config = config;
        this.prompts = prompts;
    }

    async chat(userMessage, chatHistory, context) {
        const { searchContext, ragContext, promptLoader } = context;

        // Build system prompt with RAG awareness
        let systemPrompt = this.prompts.system;
        if (ragContext) {
            systemPrompt += '\n\nYou also have access to uploaded documents. When answering from documents, cite them as [DOC 1], [DOC 2], etc.';
        }

        const messages = [
            { role: 'system', content: systemPrompt }
        ];

        const recentHistory = chatHistory.slice(-20);
        messages.push(...recentHistory);

        // Build user prompt with both contexts if available
        let userPrompt = '';

        if (ragContext && searchContext) {
            userPrompt = `The user asks: "${userMessage}"

INTERNAL DOCUMENTS:
${ragContext}

WEB SEARCH RESULTS:
${searchContext}

Answer using both sources when relevant. Cite documents as [DOC 1], [DOC 2] and web sources as [1], [2].`;
        } else if (ragContext) {
            userPrompt = `The user asks: "${userMessage}"

INTERNAL DOCUMENTS:
${ragContext}

Answer based on the documents above. Cite as [DOC 1], [DOC 2], etc.`;
        } else if (searchContext) {
            userPrompt = promptLoader.render(this.prompts.searchUser, {
                query: userMessage,
                searchContext: searchContext
            });
        } else {
            userPrompt = promptLoader.render(this.prompts.followUpUser, {
                message: userMessage
            });
        }

        messages.push({ role: 'user', content: userPrompt });

        const completion = await this.client.chat.completions.create({
            model: this.config.model,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
            messages: messages
        });

        return completion.choices[0].message.content;
    }
}

// ============================================
// AZURE FUNCTION HANDLER
// ============================================

module.exports = async function (context, req) {
    const tavilyApiKey = process.env.TAVILY_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const searchKey = process.env.AZURE_SEARCH_KEY;

    if (!tavilyApiKey || !openaiApiKey) {
        context.res = {
            status: 500,
            body: { error: 'Missing API keys configuration' }
        };
        return;
    }

    // Load prompts
    let promptConfig;
    try {
        promptConfig = await promptLoader.load();
    } catch (error) {
        context.res = {
            status: 500,
            body: { error: 'Failed to load prompt configuration: ' + error.message }
        };
        return;
    }

    // Parse request
    let message, chatHistory;
    if (req.method === 'POST') {
        message = req.body.message || '';
        chatHistory = req.body.chatHistory || [];
    } else {
        message = req.query.name || req.query.message || '';
        chatHistory = [];
    }

    if (!message) {
        context.res = { status: 400, body: { error: 'Message is required' } };
        return;
    }

    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const agent = new ConversationalAgent(openai, promptConfig.config, promptConfig.prompts);

        // Initialize RAG if configured
        let ragSearch = null;
        let hasRAGDocuments = false;

        if (searchEndpoint && searchKey) {
            ragSearch = new RAGSearch(searchEndpoint, searchKey);
            ragSearch.setOpenAI(openai);
            hasRAGDocuments = await ragSearch.hasDocuments();
        }

        let searchContext = null;
        let ragContext = null;
        let sources = [];
        let ragSources = [];

        const needsSearch = tools.shouldSearch(message, chatHistory, promptConfig.searchBehavior);
        const preferRAG = tools.shouldUseRAG(message);

        if (needsSearch) {
            const searchQuery = message.replace(/^(search for|look up|find info about|tell me about|who is|what is)\s*/i, '');

            // Determine search strategy
            if (preferRAG === true && hasRAGDocuments) {
                // User explicitly wants documents
                const ragDocs = await ragSearch.search(searchQuery);
                if (ragDocs.length > 0) {
                    ragContext = tools.formatRAGContext(ragDocs);
                    ragSources = ragDocs.map(d => ({ filename: d.filename, type: 'document' }));
                }
            } else if (preferRAG === false) {
                // User explicitly wants web search
                const searchData = await tools.webSearch(searchQuery, tavilyApiKey);
                searchContext = tools.formatSearchContext(searchData.results);
                sources = searchData.results.map(r => ({ title: r.title, url: r.url }));
            } else {
                // Try both - RAG first, then web
                if (hasRAGDocuments) {
                    const ragDocs = await ragSearch.search(searchQuery);
                    if (ragDocs.length > 0 && ragDocs[0].score > 0.7) {
                        ragContext = tools.formatRAGContext(ragDocs);
                        ragSources = ragDocs.map(d => ({ filename: d.filename, type: 'document' }));
                    }
                }

                // Also do web search for fresh context
                const searchData = await tools.webSearch(searchQuery, tavilyApiKey);
                searchContext = tools.formatSearchContext(searchData.results);
                sources = searchData.results.map(r => ({ title: r.title, url: r.url }));
            }
        }

        // Get agent response
        const response = await agent.chat(message, chatHistory, {
            searchContext,
            ragContext,
            promptLoader
        });

        context.res = {
            body: {
                agent: promptConfig.name,
                version: promptConfig.version,
                message: response,
                sources: sources,
                ragSources: ragSources,
                searchPerformed: needsSearch,
                ragUsed: !!ragContext
            }
        };

    } catch (error) {
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
