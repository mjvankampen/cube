import { normalizeQuery, stripRowLevelSecurityFlags } from '../src/query';

describe('normalizeQuery', () => {
  // CompilerApi#applyRowLevelSecurity tags the filters it derives from access policies and the
  // query goes through normalizeQuery once more afterwards, so the flag has to survive it
  it('keeps the rowLevelSecurity flag of a filter', () => {
    const { filters } = normalizeQuery({
      measures: ['orders.count'],
      filters: [{
        member: 'shipments.tenant_id',
        operator: 'equals',
        values: ['t1'],
        rowLevelSecurity: true,
      }, {
        or: [
          { member: 'shipments.carrier', operator: 'equals', values: ['dhl'] },
        ],
        rowLevelSecurity: true,
      }],
    }, false);

    expect(filters).toEqual([{
      member: 'shipments.tenant_id',
      operator: 'equals',
      values: ['t1'],
      rowLevelSecurity: true,
    }, {
      or: [
        { member: 'shipments.carrier', operator: 'equals', values: ['dhl'] },
      ],
      rowLevelSecurity: true,
    }]);
  });
});

describe('stripRowLevelSecurityFlags', () => {
  it('removes the flag at every nesting level', () => {
    expect(stripRowLevelSecurityFlags([
      { member: 'orders.status', operator: 'equals', values: ['new'], rowLevelSecurity: true },
      {
        and: [
          { member: 'orders.status', operator: 'equals', values: ['new'], rowLevelSecurity: true },
          { or: [{ member: 'orders.id', operator: 'equals', values: ['1'] }], rowLevelSecurity: true },
        ],
        rowLevelSecurity: true,
      },
    ])).toEqual([
      { member: 'orders.status', operator: 'equals', values: ['new'] },
      {
        and: [
          { member: 'orders.status', operator: 'equals', values: ['new'] },
          { or: [{ member: 'orders.id', operator: 'equals', values: ['1'] }] },
        ],
      },
    ]);
  });

  it('leaves filters without the flag alone', () => {
    const filters = [{ member: 'orders.status', operator: 'equals', values: ['new'] }];
    expect(stripRowLevelSecurityFlags(filters)).toEqual(filters);
    expect(stripRowLevelSecurityFlags(undefined)).toEqual([]);
  });
});
