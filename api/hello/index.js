const OpenAI = require('openai');

module.exports = async function (context, req) {
    const name = req.query.name || 'World';

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
        // Step 1: Search for the name using Tavily
        const searchResponse = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: tavilyApiKey,
                query: name,
                search_depth: 'basic',
                max_results: 5
            })
        });

        const searchData = await searchResponse.json();

        if (!searchResponse.ok) {
            throw new Error(searchData.error || 'Search failed');
        }

        // Step 2: Use OpenAI to summarize the results
        const openai = new OpenAI({ apiKey: openaiApiKey });

        const searchContext = searchData.results
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
            .join('\n\n');

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant. Summarize the search results about the given topic. Be concise and include relevant facts. Cite sources using [1], [2], etc.'
                },
                {
                    role: 'user',
                    content: `Summarize what you found about "${name}":\n\n${searchContext}`
                }
            ],
            max_tokens: 500
        });

        const summary = completion.choices[0].message.content;

        // Return results with sources
        context.res = {
            body: {
                message: `Hello! Here's what I found about ${name}:`,
                summary: summary,
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
