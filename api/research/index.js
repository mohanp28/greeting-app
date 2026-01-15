const OpenAI = require('openai');

// ============================================
// RESEARCH WORKFLOW - Simplified JS version
// Based on OpenAI Agent Builder workflow
// Workflow ID: wf_69692eed96408190ae45fa67ca337c22087d366e89592a85
// ============================================

// Schema definitions (matching the Agent Builder output)
// Note: additionalProperties: false is required at ALL object levels for strict mode
const webResearchSchema = {
    type: "object",
    properties: {
        companies: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    company_name: { type: "string" },
                    industry: { type: "string" },
                    headquarters_location: { type: "string" },
                    company_size: { type: "string" },
                    website: { type: "string" },
                    description: { type: "string" },
                    founded_year: { type: "number" }
                },
                required: ["company_name", "industry", "headquarters_location", "company_size", "website", "description", "founded_year"],
                additionalProperties: false
            }
        }
    },
    required: ["companies"],
    additionalProperties: false
};

const summarizeSchema = {
    type: "object",
    properties: {
        company_name: { type: "string" },
        industry: { type: "string" },
        headquarters_location: { type: "string" },
        company_size: { type: "string" },
        website: { type: "string" },
        description: { type: "string" },
        founded_year: { type: "number" }
    },
    required: ["company_name", "industry", "headquarters_location", "company_size", "website", "description", "founded_year"],
    additionalProperties: false
};

// Agent configurations (matching Agent Builder)
const webResearchAgentConfig = {
    name: "Web research agent",
    instructions: "You are a helpful assistant. Use web search to find information about the following company I can use in marketing asset based on the underlying topic.",
    model: "gpt-4o" // Using gpt-4o as gpt-5-mini may not be available
};

const summarizeAgentConfig = {
    name: "Summarize and display",
    instructions: "Put the research together in a nice display using the output format described.",
    model: "gpt-4o"
};

// ============================================
// WORKFLOW RUNNER
// ============================================

async function runResearchWorkflow(openai, inputText) {
    const conversationHistory = [];
    const results = {
        workflowId: "wf_69692eed96408190ae45fa67ca337c22087d366e89592a85",
        steps: []
    };

    // Step 1: Web Research Agent
    console.log('Running Web Research Agent...');
    const researchResponse = await openai.chat.completions.create({
        model: webResearchAgentConfig.model,
        messages: [
            { role: "system", content: webResearchAgentConfig.instructions },
            { role: "user", content: inputText }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "company_research",
                schema: webResearchSchema,
                strict: true
            }
        },
        temperature: 0.7
    });

    const researchResult = JSON.parse(researchResponse.choices[0].message.content);
    conversationHistory.push({ role: "user", content: inputText });
    conversationHistory.push({ role: "assistant", content: JSON.stringify(researchResult) });

    results.steps.push({
        agent: webResearchAgentConfig.name,
        output: researchResult
    });

    // Step 2: Summarize and Display Agent
    console.log('Running Summarize Agent...');

    // For each company found, create a summary
    const summaries = [];
    for (const company of researchResult.companies || []) {
        const summarizeResponse = await openai.chat.completions.create({
            model: summarizeAgentConfig.model,
            messages: [
                { role: "system", content: summarizeAgentConfig.instructions },
                ...conversationHistory,
                { role: "user", content: `Summarize this company information: ${JSON.stringify(company)}` }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "company_summary",
                    schema: summarizeSchema,
                    strict: true
                }
            },
            temperature: 0.5
        });

        const summary = JSON.parse(summarizeResponse.choices[0].message.content);
        summaries.push(summary);
    }

    results.steps.push({
        agent: summarizeAgentConfig.name,
        output: summaries
    });

    results.finalOutput = summaries;
    return results;
}

// ============================================
// FORMAT OUTPUT FOR DISPLAY
// ============================================

function formatCompanyCard(company) {
    return `
## ${company.company_name}

| Field | Value |
|-------|-------|
| **Industry** | ${company.industry} |
| **Headquarters** | ${company.headquarters_location} |
| **Company Size** | ${company.company_size} |
| **Website** | ${company.website} |
| **Founded** | ${company.founded_year} |

### Description
${company.description}
`;
}

// ============================================
// AZURE FUNCTION HANDLER
// ============================================

module.exports = async function (context, req) {
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
        context.res = {
            status: 500,
            body: { error: 'Missing OPENAI_API_KEY configuration' }
        };
        return;
    }

    // Parse request
    let query;
    if (req.method === 'POST') {
        query = req.body.query || req.body.message || '';
    } else {
        query = req.query.query || req.query.q || '';
    }

    if (!query) {
        context.res = {
            status: 400,
            body: { error: 'Query is required. Provide a company name or topic to research.' }
        };
        return;
    }

    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });

        console.log(`Starting research workflow for: ${query}`);
        const workflowResult = await runResearchWorkflow(openai, query);

        // Format response for display
        const formattedOutput = workflowResult.finalOutput
            .map(formatCompanyCard)
            .join('\n---\n');

        context.res = {
            body: {
                success: true,
                workflowId: workflowResult.workflowId,
                query: query,
                companies: workflowResult.finalOutput,
                formatted: formattedOutput,
                steps: workflowResult.steps.map(s => ({
                    agent: s.agent,
                    outputCount: Array.isArray(s.output) ? s.output.length : (s.output.companies?.length || 1)
                }))
            }
        };

    } catch (error) {
        console.error('Workflow error:', error);
        context.res = {
            status: 500,
            body: { error: 'Research workflow failed: ' + error.message }
        };
    }
};
