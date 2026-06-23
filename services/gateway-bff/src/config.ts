export const config = {
  port: parseInt(process.env.BFF_PORT || '8080', 10),
  decisionEngine: {
    baseUrl: process.env.DECISION_ENGINE_URL || 'http://localhost:8081',
    timeout: parseInt(process.env.DECISION_TIMEOUT || '10000', 10),
  },
  knowledgeAi: {
    baseUrl: process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083',
  },
  reportService: {
    baseUrl: process.env.REPORT_SERVICE_URL || 'http://localhost:8084',
  },
}
