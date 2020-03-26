import Driver from '../../driver';
import {Session, TableDescription, Column} from "../../table";
import {Ydb} from "../../../proto/bundle";
import {Series, getSeriesData, getSeasonsData, getEpisodesData} from './data-helpers';
import {getCredentialsFromEnv} from "../../parse-env-vars";
import getLogger, {Logger} from "../../logging";


const SERIES_TABLE = 'series';
const SEASONS_TABLE = 'seasons';
const EPISODES_TABLE = 'episodes';

async function createTables(session: Session) {
    await session.createTable(
        SERIES_TABLE,
        new TableDescription()
            .withColumn(new Column(
                'series_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'title',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UTF8}}})
            ))
            .withColumn(new Column(
                'series_info',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UTF8}}})
            ))
            .withColumn(new Column(
                'release_date',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.DATE}}})
            ))
            .withPrimaryKey('series_id')
    );

    await session.createTable(
        SEASONS_TABLE,
        new TableDescription()
            .withColumn(new Column(
                'series_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'season_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'title',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UTF8}}})
            ))
            .withColumn(new Column(
                'first_aired',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.DATE}}})
            ))
            .withColumn(new Column(
                'last_aired',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.DATE}}})
            ))
            .withPrimaryKeys('series_id', 'season_id')
    );

    await session.createTable(
        EPISODES_TABLE,
        new TableDescription()
            .withColumn(new Column(
                'series_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'season_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'episode_id',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UINT64}}})
            ))
            .withColumn(new Column(
                'title',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.UTF8}}})
            ))
            .withColumn(new Column(
                'air_date',
                Ydb.Type.create({optionalType: {item: {typeId: Ydb.Type.PrimitiveTypeId.DATE}}})
            ))
            .withPrimaryKeys('series_id', 'season_id', 'episode_id')
    );
}

async function fillTablesWithData(tablePathPrefix: string, session: Session, logger: Logger) {
    logger.info('Preparing query...');
    const query = `
PRAGMA TablePathPrefix("${tablePathPrefix}");

DECLARE $seriesData AS "List<Struct<
    series_id: Uint64,
    title: Utf8,
    series_info: Utf8,
    release_date: Utf8>>";
DECLARE $seasonsData AS "List<Struct<
    series_id: Uint64,
    season_id: Uint64,
    title: Utf8,
    first_aired: Utf8,
    last_aired: Utf8>>";
DECLARE $episodesData AS "List<Struct<
    series_id: Uint64,
    season_id: Uint64,
    episode_id: Uint64,
    title: Utf8,
    air_date: Utf8>>";

REPLACE INTO ${SERIES_TABLE}
SELECT
    series_id,
    title,
    series_info,
    CAST(release_date as Date) as release_date 
FROM AS_TABLE($seriesData);

REPLACE INTO ${SEASONS_TABLE}
SELECT
    series_id,
    season_id,
    title,
    CAST(first_aired as Date) as first_aired,
    CAST(last_aired as Date) as last_aired
FROM AS_TABLE($seasonsData);

REPLACE INTO ${EPISODES_TABLE}
SELECT
    series_id,
    season_id,
    episode_id,
    title,
    CAST(air_date as Date) as air_date
FROM AS_TABLE($episodesData);`;
    const preparedQuery = await session.prepareQuery(query);
    logger.info('Query has been prepared, executing...');
    await session.executeQuery({id: preparedQuery.queryId}, {
        '$seriesData': getSeriesData(),
        '$seasonsData': getSeasonsData(),
        '$episodesData': getEpisodesData()
    });
}

async function selectSimple(tablePathPrefix: string, session: Session): Promise<void> {
    const query = `
PRAGMA TablePathPrefix("${tablePathPrefix}");
SELECT series_id, title, series_info, release_date
FROM ${SERIES_TABLE}
WHERE series_id = 1;`;
    const {resultSets} = await session.executeQuery(query);
    return Series.createNativeObjects(resultSets[0]);
}


async function run(logger: Logger, entryPoint: string, dbName: string) {
    const authService = getCredentialsFromEnv();
    logger.info('Driver initializing...');
    const driver = new Driver(entryPoint, dbName, authService);
    const timeout = 10000;
    if (!await driver.ready(timeout)) {
        logger.fatal(`Driver has not become ready in ${timeout}ms!`);
        process.exit(1);
    }
    await driver.tableClient.withSession(async (session) => {
        logger.info('Dropping old tables...');
        await session.dropTable(SERIES_TABLE);
        await session.dropTable(EPISODES_TABLE);
        await session.dropTable(SEASONS_TABLE);
        logger.info('Creating tables...');
        await createTables(session);
        logger.info('Tables have been created, inserting data...');
        await fillTablesWithData(dbName, session, logger);
        logger.info('The data has been inserted');
    });
    logger.info('Making a simple select...');
    await driver.tableClient.withSession(async (session) => {
        const result = await selectSimple(dbName, session);
        logger.info('selectSimple result:', result);
    });
    logger.info('Testing scheme client capabilities...');
    await driver.schemeClient.makeDirectory('example-path');
    await driver.schemeClient.makeDirectory('example-path/subpath');
    await driver.schemeClient.modifyPermissions(
        'example-path/subpath',
        [{
            grant: {
                subject: 'tsufiev@staff',
                permissionNames: ['read', 'use']
            }
        }]
    );
    const entry = await driver.schemeClient.describePath('example-path');
    const children = await driver.schemeClient.listDirectory('example-path');
    logger.info(`Created path: ${JSON.stringify(entry, null, 2)}`);
    logger.info(`Path contents: ${JSON.stringify(children, null, 2)}`);
    await driver.schemeClient.removeDirectory('example-path/subpath');
    await driver.schemeClient.removeDirectory('example-path');
    await driver.destroy();
}

async function main() {
    const [,, entryPoint, dbName] = process.argv;
    const logger = getLogger({level: "debug"});
    if (!entryPoint) {
        logger.fatal('Cluster entry-point is missing, cannot run further!');
        process.exit(1);
    } else if (!dbName) {
        logger.fatal('Database name is missing, cannot run further!');
        process.exit(1);
    } else {
        logger.info(`Running basic-example script against entry-point '${entryPoint}' and database '${dbName}'.`);
    }
    try {
        await run(logger, entryPoint, dbName);
    } catch (error) {
        logger.error(error);
    }
}

main();
