#!/usr/bin/env node
// ============================================
// SALESFORCE MCP SERVER
// Provides Salesforce tools via MCP protocol
// ============================================

const readline = require('readline');

/**
 * Salesforce API Client
 */
class SalesforceClient {
    constructor(config) {
        this.instanceUrl = config.instanceUrl;
        this.accessToken = config.accessToken;
        this.apiVersion = config.apiVersion || 'v59.0';
    }

    async query(soql) {
        const url = `${this.instanceUrl}/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Query failed: ${response.status}`);
        }

        return response.json();
    }

    async describe(objectName) {
        const url = `${this.instanceUrl}/services/data/${this.apiVersion}/sobjects/${objectName}/describe`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Describe failed: ${response.status}`);
        }

        return response.json();
    }

    async listObjects() {
        const url = `${this.instanceUrl}/services/data/${this.apiVersion}/sobjects`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `List objects failed: ${response.status}`);
        }

        return response.json();
    }

    async search(searchTerm) {
        const sosl = `FIND {${searchTerm}} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name, Email), Lead(Id, Name, Email), Opportunity(Id, Name, Amount)`;
        const url = `${this.instanceUrl}/services/data/${this.apiVersion}/search?q=${encodeURIComponent(sosl)}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Search failed: ${response.status}`);
        }

        return response.json();
    }
}

/**
 * NLP to SOQL Converter
 * Uses pattern matching for common queries
 */
class NLPQueryConverter {
    constructor() {
        this.patterns = [
            // Account queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?accounts?/i,
                template: 'SELECT Id, Name, Industry, Type, Phone, Website FROM Account LIMIT 100'
            },
            {
                pattern: /accounts?\s+(?:in|from)\s+(\w+)/i,
                template: (match) => `SELECT Id, Name, Industry, Type FROM Account WHERE BillingState = '${match[1]}' OR BillingCountry = '${match[1]}' LIMIT 100`
            },
            {
                pattern: /(?:largest|biggest|top)\s+accounts?/i,
                template: 'SELECT Id, Name, AnnualRevenue, Industry FROM Account WHERE AnnualRevenue != null ORDER BY AnnualRevenue DESC LIMIT 10'
            },

            // Contact queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?contacts?/i,
                template: 'SELECT Id, Name, Email, Phone, Account.Name FROM Contact LIMIT 100'
            },
            {
                pattern: /contacts?\s+(?:at|for|from)\s+(.+)/i,
                template: (match) => `SELECT Id, Name, Email, Phone FROM Contact WHERE Account.Name LIKE '%${match[1].trim()}%' LIMIT 100`
            },

            // Opportunity queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?(?:opportunities|opps?|deals?)/i,
                template: 'SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity LIMIT 100'
            },
            {
                pattern: /(?:open|active)\s+(?:opportunities|opps?|deals?)/i,
                template: "SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC LIMIT 100"
            },
            {
                pattern: /(?:won|closed[\s-]?won)\s+(?:opportunities|opps?|deals?)/i,
                template: "SELECT Id, Name, Amount, CloseDate, Account.Name FROM Opportunity WHERE StageName = 'Closed Won' ORDER BY CloseDate DESC LIMIT 100"
            },
            {
                pattern: /(?:lost|closed[\s-]?lost)\s+(?:opportunities|opps?|deals?)/i,
                template: "SELECT Id, Name, Amount, CloseDate, Account.Name FROM Opportunity WHERE StageName = 'Closed Lost' ORDER BY CloseDate DESC LIMIT 100"
            },
            {
                pattern: /(?:opportunities|deals?)\s+closing\s+(?:this\s+)?month/i,
                template: "SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity WHERE CloseDate = THIS_MONTH AND IsClosed = false"
            },
            {
                pattern: /pipeline|forecast/i,
                template: "SELECT StageName, COUNT(Id) numDeals, SUM(Amount) totalValue FROM Opportunity WHERE IsClosed = false GROUP BY StageName"
            },

            // Lead queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?leads?/i,
                template: 'SELECT Id, Name, Email, Company, Status, LeadSource FROM Lead LIMIT 100'
            },
            {
                pattern: /(?:new|recent)\s+leads?/i,
                template: 'SELECT Id, Name, Email, Company, Status, CreatedDate FROM Lead ORDER BY CreatedDate DESC LIMIT 50'
            },
            {
                pattern: /(?:hot|qualified)\s+leads?/i,
                template: "SELECT Id, Name, Email, Company, Status FROM Lead WHERE Rating = 'Hot' OR Status = 'Qualified' LIMIT 100"
            },

            // Case queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?(?:cases?|tickets?)/i,
                template: 'SELECT Id, CaseNumber, Subject, Status, Priority, Account.Name FROM Case LIMIT 100'
            },
            {
                pattern: /(?:open|active)\s+(?:cases?|tickets?)/i,
                template: "SELECT Id, CaseNumber, Subject, Status, Priority, Account.Name FROM Case WHERE IsClosed = false ORDER BY Priority LIMIT 100"
            },

            // User queries
            {
                pattern: /(?:show|list|get|find)\s+(?:all\s+)?users?/i,
                template: 'SELECT Id, Name, Email, Profile.Name, IsActive FROM User WHERE IsActive = true LIMIT 100'
            },

            // Count queries
            {
                pattern: /(?:how many|count)\s+accounts?/i,
                template: 'SELECT COUNT() FROM Account'
            },
            {
                pattern: /(?:how many|count)\s+contacts?/i,
                template: 'SELECT COUNT() FROM Contact'
            },
            {
                pattern: /(?:how many|count)\s+(?:opportunities|deals?)/i,
                template: 'SELECT COUNT() FROM Opportunity'
            },
            {
                pattern: /(?:how many|count)\s+leads?/i,
                template: 'SELECT COUNT() FROM Lead'
            }
        ];
    }

    convert(naturalLanguage) {
        const input = naturalLanguage.trim();

        // Check if it's already a SOQL query
        if (input.toUpperCase().startsWith('SELECT') || input.toUpperCase().startsWith('FIND')) {
            return { soql: input, confidence: 1.0, isRaw: true };
        }

        // Try pattern matching
        for (const { pattern, template } of this.patterns) {
            const match = input.match(pattern);
            if (match) {
                const soql = typeof template === 'function' ? template(match) : template;
                return { soql, confidence: 0.9, pattern: pattern.toString() };
            }
        }

        // Default: try to extract object name and search
        const objectMatch = input.match(/\b(account|contact|lead|opportunity|case|user)s?\b/i);
        if (objectMatch) {
            const objectName = objectMatch[1].charAt(0).toUpperCase() + objectMatch[1].slice(1).toLowerCase();
            return {
                soql: `SELECT Id, Name FROM ${objectName} LIMIT 50`,
                confidence: 0.5,
                suggestion: `Could not parse specific query. Showing ${objectName} records.`
            };
        }

        return {
            soql: null,
            confidence: 0,
            error: 'Could not understand the query. Try: "show all accounts", "open opportunities", "contacts at Acme Corp"'
        };
    }
}

/**
 * MCP Server for Salesforce
 */
class SalesforceMCPServer {
    constructor() {
        this.client = null;
        this.nlpConverter = new NLPQueryConverter();
        this.requestId = 0;
    }

    initialize(config) {
        if (config.instanceUrl && config.accessToken) {
            this.client = new SalesforceClient(config);
            return true;
        }
        return false;
    }

    getTools() {
        return [
            {
                name: 'salesforce_nlp_query',
                description: 'Query Salesforce using natural language. Examples: "show all accounts", "open opportunities", "contacts at Acme Corp", "pipeline forecast"',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Natural language query or SOQL query'
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'salesforce_soql',
                description: 'Execute a raw SOQL query against Salesforce',
                inputSchema: {
                    type: 'object',
                    properties: {
                        soql: {
                            type: 'string',
                            description: 'SOQL query to execute'
                        }
                    },
                    required: ['soql']
                }
            },
            {
                name: 'salesforce_search',
                description: 'Search across Salesforce objects (Accounts, Contacts, Leads, Opportunities)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        searchTerm: {
                            type: 'string',
                            description: 'Term to search for'
                        }
                    },
                    required: ['searchTerm']
                }
            },
            {
                name: 'salesforce_describe',
                description: 'Get metadata about a Salesforce object (fields, relationships)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'Salesforce object name (e.g., Account, Contact, Opportunity)'
                        }
                    },
                    required: ['objectName']
                }
            },
            {
                name: 'salesforce_objects',
                description: 'List all available Salesforce objects',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    async executeTool(name, args) {
        if (!this.client) {
            return {
                content: [{
                    type: 'text',
                    text: 'Salesforce not connected. Please configure SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN.'
                }],
                isError: true
            };
        }

        try {
            switch (name) {
                case 'salesforce_nlp_query': {
                    const conversion = this.nlpConverter.convert(args.query);

                    if (!conversion.soql) {
                        return {
                            content: [{
                                type: 'text',
                                text: conversion.error
                            }],
                            isError: true
                        };
                    }

                    const result = await this.client.query(conversion.soql);

                    let responseText = '';
                    if (conversion.suggestion) {
                        responseText += `Note: ${conversion.suggestion}\n\n`;
                    }
                    responseText += `Query: ${conversion.soql}\n`;
                    responseText += `Records found: ${result.totalSize}\n\n`;
                    responseText += this.formatRecords(result.records);

                    return {
                        content: [{
                            type: 'text',
                            text: responseText
                        }]
                    };
                }

                case 'salesforce_soql': {
                    const result = await this.client.query(args.soql);
                    return {
                        content: [{
                            type: 'text',
                            text: `Records found: ${result.totalSize}\n\n${this.formatRecords(result.records)}`
                        }]
                    };
                }

                case 'salesforce_search': {
                    const result = await this.client.search(args.searchTerm);
                    return {
                        content: [{
                            type: 'text',
                            text: `Search results for "${args.searchTerm}":\n\n${JSON.stringify(result.searchRecords, null, 2)}`
                        }]
                    };
                }

                case 'salesforce_describe': {
                    const result = await this.client.describe(args.objectName);
                    const fields = result.fields.map(f => `- ${f.name} (${f.type})${f.label !== f.name ? ` - ${f.label}` : ''}`).join('\n');
                    return {
                        content: [{
                            type: 'text',
                            text: `Object: ${result.name}\nLabel: ${result.label}\n\nFields:\n${fields}`
                        }]
                    };
                }

                case 'salesforce_objects': {
                    const result = await this.client.listObjects();
                    const objects = result.sobjects
                        .filter(o => o.queryable)
                        .map(o => `- ${o.name}: ${o.label}`)
                        .join('\n');
                    return {
                        content: [{
                            type: 'text',
                            text: `Queryable Salesforce Objects:\n\n${objects}`
                        }]
                    };
                }

                default:
                    return {
                        content: [{
                            type: 'text',
                            text: `Unknown tool: ${name}`
                        }],
                        isError: true
                    };
            }
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: `Salesforce error: ${error.message}`
                }],
                isError: true
            };
        }
    }

    formatRecords(records) {
        if (!records || records.length === 0) {
            return 'No records found.';
        }

        // Format as a simple table
        return records.map((record, i) => {
            const fields = Object.entries(record)
                .filter(([key]) => key !== 'attributes')
                .map(([key, value]) => {
                    if (value && typeof value === 'object') {
                        // Handle relationship fields
                        return `${key}: ${value.Name || JSON.stringify(value)}`;
                    }
                    return `${key}: ${value}`;
                })
                .join(', ');
            return `${i + 1}. ${fields}`;
        }).join('\n');
    }

    // MCP Protocol handlers
    handleMessage(message) {
        switch (message.method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'salesforce-mcp-server',
                        version: '1.0.0'
                    }
                };

            case 'tools/list':
                return { tools: this.getTools() };

            case 'tools/call':
                return this.executeTool(message.params.name, message.params.arguments || {});

            default:
                return { error: { code: -32601, message: `Method not found: ${message.method}` } };
        }
    }

    async run() {
        // Initialize from environment variables
        const config = {
            instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
            accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
            apiVersion: process.env.SALESFORCE_API_VERSION || 'v59.0'
        };

        if (config.instanceUrl && config.accessToken) {
            this.initialize(config);
            console.error('[Salesforce MCP] Connected to:', config.instanceUrl);
        } else {
            console.error('[Salesforce MCP] Warning: Salesforce credentials not configured');
        }

        // Read from stdin, write to stdout (MCP stdio transport)
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });

        rl.on('line', async (line) => {
            try {
                const message = JSON.parse(line);
                const result = await this.handleMessage(message);

                const response = {
                    jsonrpc: '2.0',
                    id: message.id
                };

                if (result.error) {
                    response.error = result.error;
                } else {
                    response.result = result;
                }

                console.log(JSON.stringify(response));
            } catch (error) {
                console.error('[Salesforce MCP] Error:', error.message);
            }
        });
    }
}

// Run the server if executed directly
if (require.main === module) {
    const server = new SalesforceMCPServer();
    server.run();
}

module.exports = { SalesforceMCPServer, SalesforceClient, NLPQueryConverter };
