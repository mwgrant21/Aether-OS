import type { DashboardSpec } from './spec';

const DAY = "date(occurred_at_ms/1000,'unixepoch','localtime')";
const TOKEN_SUMS = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(cache_read_input_tokens) AS cache_read_input_tokens`;
const DISPATCH_DAY = "date(started_at_ms/1000,'unixepoch','localtime')";

/** Seeded once into ~/.aether-os/dashboards/ (see dashboardsStore.seedStarters); never overwritten. */
export const STARTER_BOARDS: DashboardSpec[] = [
  {
    version: 1, id: 'spend-cache', title: 'Spend & cache',
    panels: [
      { id: 'daily-spend', title: 'Spend by day (API rate)', type: 'line', range: '30d',
        sql: `SELECT ${DAY} AS day, model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY day, model`,
        cost: { basis: 'exact', groupBy: 'day' }, x: 'day', y: ['usd'] },
      { id: 'spend-by-model', title: 'Spend by model (API rate)', type: 'bar', range: '30d',
        sql: `SELECT model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY model`,
        cost: { basis: 'exact', groupBy: 'model' }, x: 'model', y: ['usd'] },
      { id: 'cache-hit-rate', title: 'Cache hit rate by day', type: 'line', range: '30d',
        // Same definition as src/shared/cacheHitRate.ts: reads / (input + reads); cache creation excluded.
        sql: `SELECT ${DAY} AS day, SUM(cache_read_input_tokens) * 1.0 / NULLIF(SUM(input_tokens) + SUM(cache_read_input_tokens), 0) AS hit_rate
          FROM usage_events WHERE occurred_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['hit_rate'] },
      { id: 'spend-24h', title: 'Spend, last 24h (API rate)', type: 'stat', range: '24h',
        sql: `SELECT 'last 24h' AS period, model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY model`,
        cost: { basis: 'exact', groupBy: 'period' }, y: ['usd'] },
    ],
  },
  {
    version: 1, id: 'agent-fleet', title: 'Agent fleet',
    panels: [
      { id: 'tool-calls', title: 'Tool calls by tool (top 15)', type: 'bar', range: '7d',
        sql: 'SELECT tool_name, COUNT(*) AS calls FROM tool_calls WHERE started_at_ms >= :since GROUP BY tool_name ORDER BY calls DESC LIMIT 15',
        x: 'tool_name', y: ['calls'] },
      { id: 'dispatches-per-day', title: 'Dispatches per day', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, COUNT(*) AS dispatches FROM dispatches WHERE started_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['dispatches'] },
      { id: 'dispatch-duration', title: 'Average dispatch duration (s)', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_duration_s FROM dispatches WHERE started_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['avg_duration_s'] },
      { id: 'dispatch-spend', title: 'Dispatch spend by day (estimate)', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, SUM(tokens) AS tokens FROM dispatches WHERE started_at_ms >= :since GROUP BY day`,
        cost: { basis: 'estimated', groupBy: 'day' }, x: 'day', y: ['usdApprox'] },
      { id: 'dispatches-by-agent', title: 'Dispatches by agent type (top 15)', type: 'bar', range: '30d',
        // dispatches.task_kind is the subagent type (collector/src/usageIngest.ts binds open.subagentType).
        sql: "SELECT COALESCE(task_kind, '(unknown)') AS agent_type, COUNT(*) AS dispatches FROM dispatches WHERE started_at_ms >= :since GROUP BY agent_type ORDER BY dispatches DESC LIMIT 15",
        x: 'agent_type', y: ['dispatches'] },
      { id: 'anomalies-by-kind', title: 'Anomalies by kind', type: 'bar', range: '30d',
        sql: "SELECT kind, SUM(anomaly_count) AS anomalies FROM daily_anomaly_rollups WHERE day >= date(:since / 1000, 'unixepoch', 'localtime') GROUP BY kind ORDER BY anomalies DESC",
        x: 'kind', y: ['anomalies'] },
      { id: 'slowest-dispatches', title: 'Slowest dispatches', type: 'table', range: '7d',
        sql: `SELECT ${DISPATCH_DAY} AS day, ROUND(duration_ms / 1000.0, 1) AS duration_s, tokens, tool_uses FROM dispatches WHERE started_at_ms >= :since ORDER BY duration_ms DESC LIMIT 20` },
    ],
  },
];
