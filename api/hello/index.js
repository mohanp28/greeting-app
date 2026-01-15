const OpenAI = require('openai');

// ============================================
// AGENT CONFIGURATION
// ============================================

const AGENT_CONFIG = {
    name: 'SearchAgent',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 1000
};

// ============================================
// PROMPT TEMPLATES
// ============================================

const PROMPTS = {
    system: `You are a helpful research assistant agent. You help users find information about people, companies, topics, and events.

CAPABILITIES:
- Search the web for current information
- Answer follow-up questions based on previous search results
- Have natural conversations while staying factual

GUIDELINES:
- Be conversational and friendly
- When you have search results, cite sources using [1], [2], etc.
- For follow-up questions, use the context from previous messages
- If asked something outside your search results, say you'd need to search for that
- Keep responses concise but informative

When presenting initial search results, structure your response with:
- A brief summary
- Key facts as bullet points
- Mention that the user can ask follow-up questions`,

    searchUser: (query, searchContext) => `
The user wants to know about: "${query}"

Here are the search results:
${searchContext}

Provide a helpful, conversational response about "${query}" using these search results. Include key facts and cite sources.`,

    followUpUser: (message) => `${message}`
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
    },

    shouldSearch: (message, chatHistory) => {
        // Search if it's the first message or explicitly asking to search
        if (chatHistory.length === 0) return true;

        const searchTriggers = ['search for', 'look up', 'find info', 'what is', 'who is', 'tell me about'];
        const lowerMessage = message.toLowerCase();
        return searchTriggers.some(trigger => lowerMessage.includes(trigger));
    }
};

// ============================================
// AGENT CLASS
// ============================================

class ConversationalAgent {
    constructor(openaiClient, config) {
        this.client = openaiClient;
        this.config = config;
    }

    async chat(userMessage, chatHistory, searchContext = null) {
        // Build messages array with history
        const messages = [
            { role: 'system', content: PROMPTS.system }
        ];

        // Add chat history (limit to last 10 exchanges to manage tokens)
        const recentHistory = chatHistory.slice(-20);
        messages.push(...recentHistory);

        // Add current user message with search context if available
        if (searchContext) {
            messages.push({
                role: 'user',
                content: PROMPTS.searchUser(userMessage, searchContext)
            });
        } else {
            messages.push({
                role: 'user',
                content: PROMPTS.followUpUser(userMessage)
            });
        }

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

    if (!tavilyApiKey || !openaiApiKey) {
        context.res = {
            status: 500,
            body: { error: 'Missing API keys configuration' }
        };
        return;
    }

    // Support both GET (simple) and POST (with history)
    let message, chatHistory;

    if (req.method === 'POST') {
        message = req.body.message || '';
        chatHistory = req.body.chatHistory || [];
    } else {
        message = req.query.name || req.query.message || '';
        chatHistory = [];
    }

    if (!message) {
        context.res = {
            status: 400,
            body: { error: 'Message is required' }
        };
        return;
    }

    try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const agent = new ConversationalAgent(openai, AGENT_CONFIG);

        let searchContext = null;
        let sources = [];

        // Determine if we need to search
        const needsSearch = tools.shouldSearch(message, chatHistory);

        if (needsSearch) {
            // Extract search query (use message directly or parse it)
            const searchQuery = message.replace(/^(search for|look up|find info about|tell me about|who is|what is)\s*/i, '');

            const searchData = await tools.webSearch(searchQuery, tavilyApiKey);
            searchContext = tools.formatSearchContext(searchData.results);
            sources = searchData.results.map(r => ({
                title: r.title,
                url: r.url
            }));
        }

        // Get agent response
        const response = await agent.chat(message, chatHistory, searchContext);

        context.res = {
            body: {
                agent: AGENT_CONFIG.name,
                message: response,
                sources: sources,
                searchPerformed: needsSearch
            }
        };

    } catch (error) {
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
