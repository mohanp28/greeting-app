const OpenAI = require('openai');

// ============================================
// AGENT CONFIGURATION
// ============================================

const AGENT_CONFIG = {
    name: 'SearchAgent',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 800
};

// ============================================
// PROMPT TEMPLATES
// ============================================

const PROMPTS = {
    system: `You are a research assistant agent. Your task is to analyze search results and provide structured, factual summaries.

RESPONSE FORMAT (you MUST follow this exact JSON structure):
{
    "name": "The searched topic/person/entity name",
    "summary": "A 2-3 sentence overview",
    "keyFacts": ["Fact 1", "Fact 2", "Fact 3", "Fact 4", "Fact 5"],
    "category": "Person | Company | Topic | Event | Other",
    "notableFor": "One sentence on why this is notable",
    "relatedTopics": ["Related 1", "Related 2", "Related 3"]
}

RULES:
- Always return valid JSON
- Be factual and concise
- Include 3-5 key facts
- Cite sources using [1], [2] notation in the summary and facts
- If information is uncertain, say "reportedly" or "according to sources"`,

    user: (query, searchContext) => `
Research query: "${query}"

Search results:
${searchContext}

Analyze these search results and provide a structured summary following the JSON format specified.`
};

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
    }
};

// ============================================
// AGENT CLASS
// ============================================

class SearchAgent {
    constructor(openaiClient, config) {
        this.client = openaiClient;
        this.config = config;
    }

    async run(query, searchResults) {
        const searchContext = tools.formatSearchContext(searchResults);

        const completion = await this.client.chat.completions.create({
            model: this.config.model,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPTS.system },
                { role: 'user', content: PROMPTS.user(query, searchContext) }
            ]
        });

        const response = JSON.parse(completion.choices[0].message.content);
        return response;
    }
}

// ============================================
// AZURE FUNCTION HANDLER
// ============================================

module.exports = async function (context, req) {
    const query = req.query.name || 'World';

    const tavilyApiKey = process.env.TAVILY_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!tavilyApiKey || !openaiApiKey) {
        context.res = {
            status: 500,
            body: { error: 'Missing API keys configuration' }
        };
        return;
    }

    try {
        // Step 1: Execute web search tool
        const searchData = await tools.webSearch(query, tavilyApiKey);

        // Step 2: Initialize and run the agent
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const agent = new SearchAgent(openai, AGENT_CONFIG);
        const agentResponse = await agent.run(query, searchData.results);

        // Step 3: Return structured response
        context.res = {
            body: {
                agent: AGENT_CONFIG.name,
                query: query,
                response: agentResponse,
                sources: searchData.results.map(r => ({
                    title: r.title,
                    url: r.url
                }))
            }
        };

    } catch (error) {
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
