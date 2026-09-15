# 屏损系统只读 MCP Server

独立的 Streamable HTTP MCP 服务，只提供固定模板的查询与统计工具。服务以 SQLite `readonly + query_only` 模式打开知识库，不注册任何写入、删除、审核或任意 SQL 工具。

## Endpoint

- MCP：`http://127.0.0.1:8090/mcp`
- 健康检查：`http://127.0.0.1:8090/health`
- 鉴权：`Authorization: Bearer <MCP_API_TOKEN>`

默认只监听服务器本机。需要远程使用时，应通过 HTTPS 反向代理暴露 `/mcp`，并把代理使用的主机名加入 `MCP_ALLOWED_HOSTS`。

## 只读工具

- `get_statistics`：系统总览或鉴定、纠错、案例、评估专项统计
- `query_assessments`：查询鉴定记录
- `query_correction_reviews`：查询纠错审核记录
- `query_cases`：查询案例库
- `query_evaluations`：查询评估记录

查询结果不会返回 Base64、图片磁盘路径、`capability_hash`、纠错原始载荷、鉴定分析原始载荷或任意令牌。

## 客户端配置示例

支持 Streamable HTTP 的客户端使用：

```json
{
  "url": "http://127.0.0.1:8090/mcp",
  "headers": {
    "Authorization": "Bearer <MCP_API_TOKEN>"
  }
}
```
