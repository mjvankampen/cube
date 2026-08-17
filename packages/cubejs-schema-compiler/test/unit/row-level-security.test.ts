import { PostgresQuery } from '../../src';
import { prepareJsCompiler } from './PrepareCompiler';

/**
 * Access policies are evaluated by CompilerApi#applyRowLevelSecurity, which pushes the resulting
 * filters onto the query with a `rowLevelSecurity` flag. These tests cover what the query planners
 * do with that flag, so the filters are handed over directly instead of going through RBAC.
 */
describe.each([
  ['JS query planner', false],
  ['native query planner', true],
])('Row level security filters (%s)', (_name, useNativeSqlPlanner) => {
  const compilers = prepareJsCompiler(`
cube('orders', {
  sql_table: 'public.orders',

  joins: {
    shipments: {
      sql: \`\${CUBE}.id = \${shipments}.order_id\`,
      relationship: 'one_to_one',
    },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
    tenant_id: {
      sql: 'tenant_id',
      type: 'string',
    },
  },

  measures: {
    count: {
      type: 'count',
    },
  },
});

cube('shipments', {
  sql_table: 'public.shipments',

  dimensions: {
    order_id: {
      sql: 'order_id',
      type: 'string',
      primary_key: true,
    },
    tenant_id: {
      sql: 'tenant_id',
      type: 'string',
    },
    carrier: {
      sql: 'carrier',
      type: 'string',
    },
  },
});
`);

  const tenantFilter = (member: string, rowLevelSecurity: boolean) => ({
    member,
    operator: 'equals',
    values: ['t1'],
    ...(rowLevelSecurity ? { rowLevelSecurity } : {}),
  });

  const buildQuery = (query: any) => new PostgresQuery(compilers, {
    timezone: 'UTC',
    useNativeSqlPlanner,
    ...query,
  });

  it('applies a filter of a joined cube in the join condition, keeping the LEFT JOIN semantics', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [tenantFilter('shipments.tenant_id', true)],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).toContain('ON "orders".id = "shipments".order_id AND ("shipments".tenant_id = $1)');
    // Applying it after the join would discard the orders without a matching shipment
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual(['t1']);
  });

  it('applies a plain filter of a joined cube in the outer WHERE', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [tenantFilter('shipments.tenant_id', false)],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).not.toContain('"shipments".order_id AND');
    expect(sql).toContain('WHERE ("shipments".tenant_id = $1)');
    expect(params).toEqual(['t1']);
  });

  it('applies a filter of the join root in the outer WHERE', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [tenantFilter('orders.tenant_id', true)],
    });

    const [sql, params] = query.buildSqlAndParams();
    // Nothing is on the optional side of the join here, so the WHERE drops no extra rows
    expect(sql).not.toContain('"shipments".order_id AND');
    expect(sql).toContain('WHERE ("orders".tenant_id = $1)');
    expect(params).toEqual(['t1']);
  });

  it('applies a filter of a joined cube in the join condition of an aggregating query', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      measures: ['orders.count'],
      dimensions: ['shipments.carrier'],
      filters: [tenantFilter('shipments.tenant_id', true)],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).toContain('ON "orders".id = "shipments".order_id AND ("shipments".tenant_id = $1)');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual(['t1']);
  });

  it('keeps a nested filter scoped to a single joined cube in the join condition', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [{
        // Policies of several roles are combined with `or`, which is still pushed down as long
        // as every member belongs to the same cube
        or: [
          tenantFilter('shipments.tenant_id', false),
          { member: 'shipments.carrier', operator: 'equals', values: ['dhl'] },
        ],
        rowLevelSecurity: true,
      }],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).toContain('ON "orders".id = "shipments".order_id AND (("shipments".tenant_id = $1) OR ("shipments".carrier = $2))');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual(['t1', 'dhl']);
  });

  it('keeps a filter spanning several cubes in the outer WHERE', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [{
        // There's no single join condition this could be moved to without changing its meaning
        or: [
          tenantFilter('shipments.tenant_id', false),
          tenantFilter('orders.tenant_id', false),
        ],
        rowLevelSecurity: true,
      }],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).not.toContain('"shipments".order_id AND');
    expect(sql).toContain('WHERE (("shipments".tenant_id = $1) OR ("orders".tenant_id = $2))');
    expect(params).toEqual(['t1', 't1']);
  });

  it('applies filters of both sides of a join to the side they belong to', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id', 'shipments.carrier'],
      filters: [
        tenantFilter('orders.tenant_id', true),
        tenantFilter('shipments.tenant_id', true),
      ],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).toContain('ON "orders".id = "shipments".order_id AND ("shipments".tenant_id = $1)');
    expect(sql).toContain('WHERE ("orders".tenant_id = $2)');
    expect(params).toEqual(['t1', 't1']);
  });

  it('does not apply a filter of a cube that is not part of the query', async () => {
    await compilers.compiler.compile();

    const query = buildQuery({
      dimensions: ['orders.id'],
      filters: [tenantFilter('orders.tenant_id', true)],
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(sql).not.toContain('shipments');
    expect(sql).toContain('WHERE ("orders".tenant_id = $1)');
    expect(params).toEqual(['t1']);
  });

  it('applies a filter of a joined cube in the WHERE of a query served by a pre-aggregation', async () => {
    // A query reading from a rollup has no join to move the filter to, so it has to stay in the
    // WHERE - dropping it there would let the rows the policy hides through
    const rollupCompilers = prepareJsCompiler(`
cube('orders', {
  sql_table: 'public.orders',

  joins: {
    shipments: {
      sql: \`\${CUBE}.id = \${shipments}.order_id\`,
      relationship: 'one_to_one',
    },
  },

  pre_aggregations: {
    ordersByCarrier: {
      measures: [CUBE.count],
      dimensions: [shipments.carrier, shipments.tenant_id],
    },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
  },

  measures: {
    count: {
      type: 'count',
    },
  },
});

cube('shipments', {
  sql_table: 'public.shipments',

  dimensions: {
    order_id: {
      sql: 'order_id',
      type: 'string',
      primary_key: true,
    },
    tenant_id: {
      sql: 'tenant_id',
      type: 'string',
    },
    carrier: {
      sql: 'carrier',
      type: 'string',
    },
  },
});
`);
    await rollupCompilers.compiler.compile();

    const query = new PostgresQuery(rollupCompilers, {
      measures: ['orders.count'],
      dimensions: ['shipments.carrier'],
      filters: [tenantFilter('shipments.tenant_id', true)],
      timezone: 'UTC',
      preAggregationsSchema: '',
      useNativeSqlPlanner,
    });

    const [sql, params] = query.buildSqlAndParams();
    expect(query.preAggregations?.preAggregationsDescription()[0].preAggregationId)
      .toEqual('orders.ordersByCarrier');
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toContain('WHERE ("shipments__tenant_id" = $1)');
    expect(params).toEqual(['t1']);
  });
});
