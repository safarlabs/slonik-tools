import { InterceptorType, QueryResultRowType, sql as slonikSql, TaggedTemplateLiteralInvocationType, ValueExpressionType } from 'slonik'

import * as fs from 'fs'
import { basename, join } from 'path'
import { typeNameToOid } from './types'

const keys = <T>(obj: T) => Object.keys(obj) as Array<keyof T>
const toPairs = <T>(obj: T) => keys(obj).map(k => [k, obj[k]] as [keyof T, T[keyof T]])
const fromPairs = <K, V>(pairs: Array<[K, V]>) => pairs.reduce(
  (obj, [k, v]) => ({ ...obj, [k as any]: v }),
  {} as Record<string, V>
) as Record<string, V>
const orderBy = <T>(list: T[], cb: (value: T) => string | number) => [...list].sort((a, b) => {
  const left = cb(a)
  const right = cb(b)
  return left < right ? -1 : left > right ? 1 : 0
})

const nameOidPairs = toPairs(typeNameToOid)
const oidToTypeName = fromPairs(nameOidPairs.map(([name, oid]) => [oid, name]))

export { typeNameToOid }
export const typeNames: { [K in keyof typeof typeNameToOid]: K } =
  fromPairs(nameOidPairs.map(([name]) => [name, name])) as any

export interface GenericSqlTaggedTemplateType<T> {
  <U = T>(template: TemplateStringsArray, ...vals: ValueExpressionType[]): TaggedTemplateLiteralInvocationType<U>
}

export interface SlonikTsConfig<KnownTypes> {
  knownTypes: KnownTypes
  /**
   * where to write types.
   * if this is a string, types will be written to the path with that value
   */
  writeTypes?: false | string
  /** if true, generated code directory will be reset on startup. */
  reset?: boolean
  /**
   * map from postgres data type id (oid) to io-ts-codegen type.
   */
  typeMapper?: (dataTypeId: number, types: typeof typeNameToOid) => string | undefined
}

export type DefaultType<KnownTypes> = {
  [K in 'defaultType']: K extends keyof KnownTypes ? KnownTypes[K] : QueryResultRowType
}['defaultType']

export interface SlonikTs<KnownTypes> {
  interceptor: InterceptorType
  sql: typeof slonikSql & {
    [K in keyof KnownTypes]: GenericSqlTaggedTemplateType<KnownTypes[K]>
  } & {
    [K in string]: GenericSqlTaggedTemplateType<DefaultType<KnownTypes>>
  }
}

export const setupSlonikTs = <KnownTypes>(config: SlonikTsConfig<KnownTypes>): SlonikTs<KnownTypes> => {
  const sqlGetter = setupSqlGetter(config)
  const _sql: any = (...args: Parameters<typeof slonikSql>) => slonikSql(...args)
  Object.keys(config.knownTypes).forEach(name => _sql[name] = sqlGetter.sql(name))
  return {
    interceptor: sqlGetter.interceptor,
    sql: new Proxy(_sql, {
      get(_, key) {
        if (typeof key === 'string' && !(key in _sql)) {
          return _sql[key] = sqlGetter.sql(key)
        }
        return _sql[key]
      },
    }),
  }
}

export interface Functionalsql<KnownTypes> {
  interceptor: InterceptorType
  sql: <Identifier extends string>(identifier: Identifier) =>
    GenericSqlTaggedTemplateType<Identifier extends keyof KnownTypes ? KnownTypes[Identifier] : any>
}

export const createCodegenDirectory = (directory: string) => {
  fs.mkdirSync(directory, {recursive: true})
  fs.writeFileSync(join(directory, 'index.ts'), 'export const knownTypes = {}\n', 'utf8')
}

export const resetCodegenDirectory = (directory: string) => {
  if (fs.existsSync(directory)) {
    fs.readdirSync(directory)
      .forEach(filename => fs.unlinkSync(join(directory, filename)))
    fs.rmdirSync(directory)
  }
  createCodegenDirectory(directory)
}

export const setupSqlGetter = <KnownTypes>(config: SlonikTsConfig<KnownTypes>): Functionalsql<KnownTypes> => {
  if (config.reset && typeof config.writeTypes === 'string') {
    resetCodegenDirectory(config.writeTypes)
  }
  if (!config.writeTypes) {
    // not writing types, no need to track queries or intercept results
    return {
      sql: Object.assign(
        () => slonikSql,
        fromPairs(keys(config.knownTypes).map(k => [k, slonikSql])),
      ),
      interceptor: {},
    }
  }
  const writeTypes = (typeof config.writeTypes === 'string')
    ? getFsTypeWriter(config.writeTypes)
    : config.writeTypes
    
  if (typeof config.writeTypes === 'string' && !fs.existsSync(config.writeTypes)) {
    createCodegenDirectory(config.writeTypes)
  }

  const typeMapper = (dataTypeId: number, types: typeof typeNameToOid) =>
    (config.typeMapper && config.typeMapper(dataTypeId, types)) || tsTypeFromPgType(dataTypeId)

  const _map: Record<string, string[] | undefined> = {}
  const mapKey = (sqlValue: { sql: string, values?: any }) =>
    JSON.stringify([sqlValue.sql, sqlValue.values])

  const sql: Functionalsql<KnownTypes>['sql'] = identifier => {
    const _wrappedSqlFunction = (...args: Parameters<typeof slonikSql>) => {
      const result = slonikSql(...args)
      const key = mapKey(result)
      const _identifiers = _map[key] = _map[key] || []
      _identifiers.push(identifier)
      return result
    }
    return Object.assign(_wrappedSqlFunction, slonikSql)
  }
  return {
    sql,
    interceptor: {
      afterQueryExecution: ({ originalQuery }, _query, result) => {
        const trimmedSql = originalQuery.sql.replace(/^\n+/, '').trimRight()
        const _identifiers = _map[mapKey(originalQuery)]
        _identifiers && _identifiers.forEach(identifier => writeTypes(
          identifier,
          result.fields.map(f => ({
            name: f.name,
            value: typeMapper(f.dataTypeID, typeNameToOid),
            description: `${oidToTypeName[f.dataTypeID]} (oid: ${f.dataTypeID})`,
          })),
          trimmedSql.trim(),
        ))

        return result
      }
    }
  }
}

export interface Property { name: string, value: string, description?: string }
const blockComment = (str?: string) => str && '/** ' + str.replace(/\*\//g, '') + ' */'
const codegen = {
  writeInterface: (name: string, exported: boolean, properties: Property[], description?: string) =>
    `${exported ? 'export' : ''} interface ${name} ` + codegen.writeInterfaceBody(properties, description),

  writeInterfaceBody: (properties: Property[], description?: string) => [
    blockComment(description),
    `{`,
    ...properties.map(p => [
      blockComment(p.description),
      `${p.name}: ${p.value}`
    ].filter(Boolean).map(s => '  ' + s).join('\n')),
    `}`,
  ].filter(Boolean).join('\n')
}
const getFsTypeWriter = (generatedPath: string) =>
  (typeName: string, properties: Property[], description: string) => {
    const header = [
      '/* eslint-disable */',
      '// tslint:disable',
      `// this file is generated by a tool; don't change it manually.`,
    ].join('\n')
    const tsPath = join(generatedPath, `${typeName}.ts`)
    const existingContent = fs.existsSync(tsPath)
      ? fs.readFileSync(tsPath, 'utf8')
      : ''
    const metaDeclaration = `export const ${typeName}_meta_v0 = `
    const lines = existingContent.split('\n').map(line => line.trim())
    const metaLine = lines.find(line => line.startsWith(metaDeclaration)) || '[]'
    let _entries: Array<typeof newEntry> = JSON.parse(metaLine.replace(metaDeclaration, ''))

    const newEntry = { properties, description }
    _entries.push(newEntry)
    _entries = orderBy(_entries, e => e.description)
    _entries = _entries
      .filter((e, i, arr) => i === arr.findIndex(x => x.description === e.description))

    const contnt = [
      header,
      ``,
      `export interface ${typeName}_QueryTypeMap {`,
      '  ' + _entries
        .map(e => `[${JSON.stringify(e.description)}]: ${codegen.writeInterfaceBody(e.properties)}`)
        .join('\n')
        .replace(/\n/g, '\n  '),
      `}`,
      ``,
      `export type ${typeName}_UnionType = ${typeName}_QueryTypeMap[keyof ${typeName}_QueryTypeMap]`,
      ``,
      `export type ${typeName} = {`,
      `  [K in keyof ${typeName}_UnionType]: ${typeName}_UnionType[K]`,
      `}`,
      ``,
      `${metaDeclaration}${JSON.stringify(_entries)}`,
      ``,
    ].join('\n')

    void fs.writeFileSync(tsPath, contnt, 'utf8')

    const knownTypes = fs.readdirSync(generatedPath)
      .filter(filename => filename !== 'index.ts')
      .map(filename => basename(filename, '.ts'))

    void fs.writeFileSync(
      join(generatedPath, `index.ts`),
      [
        header,
        ...knownTypes.map(name => `import {${name}} from './${name}'`),
        '',
        ...knownTypes.map(name => `export {${name}}`),
        '',
        codegen.writeInterface('KnownTypes', true, knownTypes.map(name => ({ name, value: name }))),
        '',
        '/** runtime-accessible object with phantom type information of query results. */',
        `export const knownTypes: KnownTypes = {`,
        ...knownTypes.map(name => `  ${name}: {} as ${name},`),
        `}`,
        '',
      ].join('\n')
    )
  }

const tsTypeFromPgType = (dataTypeID: number) => {
  switch (dataTypeID) {
    case typeNameToOid.timestamptz:
      return 'number'

    case typeNameToOid.text:
    case typeNameToOid.varchar:
      return 'string'

    case typeNameToOid.int2:
    case typeNameToOid.int4:
    case typeNameToOid.int8:
      return 'number'

    case typeNameToOid.bool:
      return 'boolean'

    case typeNameToOid._text:
      return 'string[]'

    default:
      return 'unknown'
  }
}