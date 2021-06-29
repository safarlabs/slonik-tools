import * as fsSyncer from 'fs-syncer'
import * as typegen from '../src'
import {createTypeParserPreset} from 'slonik'
import {getHelper, getPoolHelper} from './helper'

export const {typegenOptions, logger, poolHelper: helper} = getHelper({__filename})

const {pool} = getPoolHelper({
  __filename,
  baseConnectionURI: typegenOptions(__dirname).connectionURI!.slice(),
  config: {
    typeParsers: [
      ...createTypeParserPreset(),
      {
        name: 'timestamptz',
        parse: str => new Date(str),
      },
      {
        name: 'int8',
        parse: str => BigInt(str),
      },
      {
        name: 'bool',
        parse: str => Boolean(str),
      },
      {
        name: 'json',
        parse: () => Symbol(`this won't be matched by anything so should result in an 'unknown' type`),
      },
    ],
  },
})

test('type parsers have types inferred', async () => {
  const syncer = fsSyncer.jestFixture({
    targetState: {
      'index.ts': `
        import {sql} from 'slonik'
  
        export default [
          sql\`select '2000-01-01'::timestamptz, 1::int8, true::bool, '{}'::json\`,
        ]
      `,
    },
  })

  const baseParams = typegenOptions(syncer.baseDir)

  syncer.sync()

  await typegen.generate({
    ...baseParams,
    poolConfig: pool.configuration,
  })

  expect(syncer.yaml()).toMatchInlineSnapshot(`
    "---
    index.ts: |-
      import {sql} from 'slonik'
      
      export default [
        sql<queries.Timestamptz_int8_bool_json>\`select '2000-01-01'::timestamptz, 1::int8, true::bool, '{}'::json\`,
      ]
      
      export declare namespace queries {
        // Generated by @slonik/typegen
      
        /** - query: \`select '2000-01-01'::timestamptz, 1::int8, true::bool, '{}'::json\` */
        export interface Timestamptz_int8_bool_json {
          /** regtype: \`timestamp with time zone\` */
          timestamptz: Date | null
      
          /** regtype: \`bigint\` */
          int8: bigint | null
      
          /** regtype: \`boolean\` */
          bool: boolean | null
      
          /** regtype: \`json\` */
          json: unknown
        }
      }
      "
  `)
})