const OpenAI = require('openai');
const { SalesforceClient, NLPQueryConverter } = require('../mcp/salesforce-server');

// ============================================
// SALESFORCE API ENDPOINT
// Query Salesforce using natural language
// ============================================

module.exports = async function (context, req) {
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
    const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    // GET - Check connection status
    if (req.method === 'GET') {
        const action = req.query.action;

        if (action === 'status') {
            const connected = !!(instanceUrl && accessToken);
            let orgInfo = null;

            if (connected) {
                try {
                    const client = new SalesforceClient({ instanceUrl, accessToken });
                    const result = await client.query('SELECT Id, Name FROM Organization LIMIT 1');
                    orgInfo = result.records[0];
                } catch (error) {
                    orgInfo = { error: error.message };
                }
            }

            context.res = {
                body: {
                    connected,
                    instanceUrl: connected ? instanceUrl : null,
                    organization: orgInfo
                }
            };
            return;
        }

        if (action === 'objects') {
            if (!instanceUrl || !accessToken) {
                context.res = { status: 401, body: { error: 'Salesforce not configured' } };
                return;
            }

            try {
                const client = new SalesforceClient({ instanceUrl, accessToken });
                const result = await client.listObjects();
                const objects = result.sobjects
                    .filter(o => o.queryable && !o.name.endsWith('__History') && !o.name.endsWith('__Share'))
                    .map(o => ({ name: o.name, label: o.label }));

                context.res = { body: { objects } };
            } catch (error) {
                context.res = { status: 500, body: { error: error.message } };
            }
            return;
        }

        context.res = {
            body: {
                endpoints: {
                    'GET ?action=status': 'Check Salesforce connection status',
                    'GET ?action=objects': 'List available Salesforce objects',
                    'POST { query }': 'Execute natural language query',
                    'POST { soql }': 'Execute raw SOQL query'
                }
            }
        };
        return;
    }

    // POST - Execute query
    if (req.method === 'POST') {
        if (!instanceUrl || !accessToken) {
            context.res = {
                status: 401,
                body: { error: 'Salesforce not configured. Set SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN.' }
            };
            return;
        }

        const { query, soql, useAI } = req.body || {};

        if (!query && !soql) {
            context.res = {
                status: 400,
                body: { error: 'Either "query" (natural language) or "soql" (raw SOQL) is required' }
            };
            return;
        }

        try {
            const client = new SalesforceClient({ instanceUrl, accessToken });
            let finalSoql;
            let conversion = null;

            if (soql) {
                // Direct SOQL query
                finalSoql = soql;
            } else if (useAI && openaiApiKey) {
                // Use AI for complex NLP to SOQL conversion
                conversion = await convertWithAI(query, openaiApiKey, client);
                finalSoql = conversion.soql;
            } else {
                // Use pattern-based NLP converter
                const nlpConverter = new NLPQueryConverter();
                conversion = nlpConverter.convert(query);

                if (!conversion.soql) {
                    context.res = {
                        status: 400,
                        body: {
                            error: conversion.error,
                            suggestion: 'Try enabling AI mode for complex queries or use these examples:',
                            examples: [
                                'show all accounts',
                                'open opportunities',
                                'contacts at Acme Corp',
                                'pipeline forecast',
                                'leads from California',
                                'how many contacts'
                            ]
                        }
                    };
                    return;
                }
                finalSoql = conversion.soql;
            }

            // Execute the query
            const result = await client.query(finalSoql);

            context.res = {
                body: {
                    success: true,
                    query: query || null,
                    soql: finalSoql,
                    conversion: conversion ? {
                        confidence: conversion.confidence,
                        suggestion: conversion.suggestion
                    } : null,
                    totalRecords: result.totalSize,
                    records: result.records.map(r => {
                        // Clean up Salesforce response
                        const clean = { ...r };
                        delete clean.attributes;
                        return clean;
                    })
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
        status: 405,
        body: { error: 'Method not allowed' }
    };
};

/**
 * Use OpenAI to convert complex natural language to SOQL
 */
async function convertWithAI(query, apiKey, sfClient) {
    const openai = new OpenAI({ apiKey });

    // Get available objects for context
    let objectsContext = '';
    try {
        const objects = await sfClient.listObjects();
        const commonObjects = objects.sobjects
            .filter(o => ['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'User', 'Task', 'Event'].includes(o.name))
            .map(o => o.name);
        objectsContext = `Available objects: ${commonObjects.join(', ')}`;
    } catch (e) {
        objectsContext = 'Common objects: Account, Contact, Lead, Opportunity, Case, User';
    }

    const systemPrompt = `You are a Salesforce SOQL expert. Convert natural language queries to valid SOQL.

${objectsContext}

Common field patterns:
- Account: Id, Name, Industry, Type, Phone, Website, BillingCity, BillingState, AnnualRevenue
- Contact: Id, Name, Email, Phone, Title, Account.Name, AccountId
- Opportunity: Id, Name, Amount, StageName, CloseDate, IsClosed, IsWon, Account.Name
- Lead: Id, Name, Email, Company, Status, LeadSource, Rating
- Case: Id, CaseNumber, Subject, Status, Priority, IsClosed, Account.Name

Rules:
1. Always include Id in SELECT
2. Use LIMIT for safety (default 100)
3. Handle date literals: TODAY, THIS_MONTH, LAST_N_DAYS:30, etc.
4. Return ONLY the SOQL query, no explanation

Examples:
- "top 10 accounts by revenue" -> SELECT Id, Name, AnnualRevenue FROM Account ORDER BY AnnualRevenue DESC LIMIT 10
- "contacts at companies in tech industry" -> SELECT Id, Name, Email, Account.Name FROM Contact WHERE Account.Industry = 'Technology' LIMIT 100
- "opportunities closing next week" -> SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE CloseDate = NEXT_WEEK LIMIT 100`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
        ]
    });

    const soql = response.choices[0].message.content.trim();

    return {
        soql,
        confidence: 0.85,
        aiGenerated: true
    };
}
