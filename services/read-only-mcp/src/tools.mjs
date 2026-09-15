import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须使用 YYYY-MM-DD').optional()
const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认20，最多100'),
  offset: z.number().int().min(0).max(1_000_000).optional().describe('分页偏移量，默认0'),
}
const common = {
  keyword: z.string().trim().max(100).optional().describe('模糊搜索关键词'),
  dateFrom: date.describe('创建日期起点，YYYY-MM-DD'),
  dateTo: date.describe('创建日期终点，YYYY-MM-DD'),
  ...pagination,
}
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

function response(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function audited(name, handler) {
  return async args => {
    const started = Date.now()
    try {
      const result = await handler(args)
      console.log(JSON.stringify({ event: 'mcp_tool_call', tool: name, success: true, durationMs: Date.now() - started }))
      return response(result)
    } catch (error) {
      console.warn(JSON.stringify({ event: 'mcp_tool_call', tool: name, success: false, durationMs: Date.now() - started, error: error.message }))
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
  }
}

export function buildMcpServer(store) {
  const server = new McpServer(
    { name: 'screen-damage-read-only', version: '1.0.0' },
    { instructions: '本服务只提供固定模板的只读查询和统计，不支持任意 SQL、图片原文、文件路径、令牌或任何写操作。' },
  )

  server.registerTool('get_statistics', {
    title: '获取系统统计',
    description: '获取鉴定系统总览，或鉴定、纠错审核、案例、评估专项统计。只读。',
    inputSchema: z.object({
      scope: z.enum(['overview', 'assessments', 'corrections', 'cases', 'evaluations']).default('overview'),
    }),
    annotations: readOnlyAnnotations,
  }, audited('get_statistics', ({ scope }) => store.getStatistics(scope)))

  server.registerTool('query_assessments', {
    title: '查询鉴定记录',
    description: '分页查询鉴定记录及状态，不返回图片、Base64、分析原始载荷或能力令牌。只读。',
    inputSchema: z.object({
      id: z.number().int().positive().optional(),
      submissionId: z.string().trim().max(128).optional(),
      processStatus: z.enum(['analyzing', 'completed', 'failed']).optional(),
      feedbackStatus: z.enum(['unconfirmed', 'confirmed_correct', 'reported_incorrect', 'corrected']).optional(),
      ...common,
    }),
    annotations: readOnlyAnnotations,
  }, audited('query_assessments', args => store.queryAssessments(args)))

  server.registerTool('query_correction_reviews', {
    title: '查询纠错审核记录',
    description: '分页查询纠错审核记录和图片存储状态，不返回Base64或磁盘路径。只读。',
    inputSchema: z.object({
      id: z.number().int().positive().optional(),
      status: z.enum(['pending', 'approving', 'approved', 'rejected']).optional(),
      ...common,
    }),
    annotations: readOnlyAnnotations,
  }, audited('query_correction_reviews', args => store.queryCorrectionReviews(args)))

  server.registerTool('query_cases', {
    title: '查询案例库',
    description: '分页查询案例特征和结论，不返回案例图片文件名。只读。',
    inputSchema: z.object({
      id: z.string().trim().max(160).optional(),
      result: z.string().trim().max(100).optional(),
      reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
      ...common,
    }),
    annotations: readOnlyAnnotations,
  }, audited('query_cases', args => store.queryCases(args)))

  server.registerTool('query_evaluations', {
    title: '查询评估记录',
    description: '分页查询模型评估、人审答案和匹配结果，不返回图片内容。只读。',
    inputSchema: z.object({
      id: z.number().int().positive().optional(),
      caseId: z.string().trim().max(160).optional(),
      analyzed: z.boolean().optional(),
      ...common,
    }),
    annotations: readOnlyAnnotations,
  }, audited('query_evaluations', args => store.queryEvaluations(args)))

  return server
}
