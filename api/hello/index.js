const OpenAI = require('openai');
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
        // Check cache
        if (this.cache && (Date.now() - this.cacheTime) < this.cacheTTL) {
            return this.cache;
        }

        let promptConfig;

        // Try Azure Blob Storage first (for hot-reload)
        if (process.env.PROMPT_BLOB_URL) {
            try {
                const response = await fetch(process.env.PROMPT_BLOB_URL);
                if (response.ok) {
                    promptConfig = await response.json();
                    console.log('Loaded prompts from Azure Blob Storage');
                }
            } catch (error) {
                console.warn('Failed to load from Blob, falling back to local:', error.message);
            }
        }

        // Fallback to local file
        if (!promptConfig) {
            const localPath = path.join(__dirname, '..', 'prompts', 'search-agent.json');
            const fileContent = fs.readFileSync(localPath, 'utf-8');
            promptConfig = JSON.parse(fileContent);
            console.log('Loaded prompts from local file');
        }

        this.cache = promptConfig;
        this.cacheTime = Date.now();
        return promptConfig;
    }

    // Template variable replacement
    render(template, variables) {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return variables[key] !== undefined ? variables[key] : match;
        });
    }
}

const promptLoader = new PromptLoader();

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

    shouldSearch: (message, chatHistory, searchBehavior) => {
        // Always search on first message
        if (chatHistory.length === 0) return true;

        const lowerMessage = message.toLowerCase();

        // Explicit search triggers - always search
        if (searchBehavior.explicitTriggers.some(trigger => lowerMessage.includes(trigger))) {
            return true;
        }

        // Follow-up indicators - don't search, use context
        if (searchBehavior.followUpIndicators.some(indicator => lowerMessage.includes(indicator))) {
            return false;
        }

        // Short questions with ? are likely follow-ups
        if (message.split(' ').length <= searchBehavior.maxShortQuestionWords && message.includes('?')) {
            return false;
        }

        // Otherwise, treat as a new topic and search
        return true;
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

    async chat(userMessage, chatHistory, searchContext = null, promptLoader) {
        // Build messages array with history
        const messages = [
            { role: 'system', content: this.prompts.system }
        ];

        // Add chat history (limit to last 20 messages)
        const recentHistory = chatHistory.slice(-20);
        messages.push(...recentHistory);

        // Add current user message with search context if available
        if (searchContext) {
            const userPrompt = promptLoader.render(this.prompts.searchUser, {
                query: userMessage,
                searchContext: searchContext
            });
            messages.push({ role: 'user', content: userPrompt });
        } else {
            const userPrompt = promptLoader.render(this.prompts.followUpUser, {
                message: userMessage
            });
            messages.push({ role: 'user', content: userPrompt });
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

    // Load prompts (with caching)
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
        const agent = new ConversationalAgent(openai, promptConfig.config, promptConfig.prompts);

        let searchContext = null;
        let sources = [];

        // Determine if we need to search
        const needsSearch = tools.shouldSearch(message, chatHistory, promptConfig.searchBehavior);

        if (needsSearch) {
            // Extract search query
            const searchQuery = message.replace(/^(search for|look up|find info about|tell me about|who is|what is)\s*/i, '');

            const searchData = await tools.webSearch(searchQuery, tavilyApiKey);
            searchContext = tools.formatSearchContext(searchData.results);
            sources = searchData.results.map(r => ({
                title: r.title,
                url: r.url
            }));
        }

        // Get agent response
        const response = await agent.chat(message, chatHistory, searchContext, promptLoader);

        context.res = {
            body: {
                agent: promptConfig.name,
                version: promptConfig.version,
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
