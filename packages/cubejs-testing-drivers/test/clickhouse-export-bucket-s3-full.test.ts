import { testQueries } from '../src/tests/testQueries';

testQueries('clickhouse', {
  includeIncrementalSchemaSuite: true,
  includeHLLSuite: true,
  extendedEnv: 'export-bucket-s3'
});
