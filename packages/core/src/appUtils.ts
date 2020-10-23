import { SN, Sinc } from "@sincronia/types";
import path from "path";
import ProgressBar from "progress";
import * as fUtils from "./FileUtils";
import * as SNClient from "./server";
import ConfigManager from "./config";
import { PATH_DELIMITER, PUSH_RETRY_LIMIT, PUSH_RETRY_WAIT } from "./constants";
import PluginManager from "./PluginManager";
import {
  defaultClient as clientFactory,
  processPushResponse,
  retryOnErr,
  processSimpleResponse
} from "./snClient";
import { logger } from "./Logger";
import { aggregateErrorMessages, allSettled } from "./genericUtils";

const processFilesInManRec = async (
  recPath: string,
  rec: SN.MetaRecord,
  forceWrite: boolean
) => {
  const fileWrite = fUtils.writeSNFileCurry(forceWrite);
  const filePromises = rec.files.map(file => fileWrite(file, recPath));
  await Promise.all(filePromises);
  // Side effect, remove content from files so it doesn't get written to manifest
  rec.files.forEach(file => {
    delete file.content;
  });
};

const processRecsInManTable = async (
  tablePath: string,
  table: SN.TableConfig,
  forceWrite: boolean
) => {
  const { records } = table;
  const recKeys = Object.keys(records);
  const recKeyToPath = (key: string) => path.join(tablePath, records[key].name);
  const recPathPromises = recKeys
    .map(recKeyToPath)
    .map(fUtils.createDirRecursively);
  await Promise.all(recPathPromises);

  const filePromises = recKeys.reduce(
    (acc: Promise<void>[], recKey: string) => {
      return [
        ...acc,
        processFilesInManRec(recKeyToPath(recKey), records[recKey], forceWrite)
      ];
    },
    [] as Promise<void>[]
  );
  return Promise.all(filePromises);
};

const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean
) => {
  const tableNames = Object.keys(tables);
  const tablePromises = tableNames.map(tableName => {
    return processRecsInManTable(
      path.join(ConfigManager.getSourcePath(), tableName),
      tables[tableName],
      forceWrite
    );
  });
  await Promise.all(tablePromises);
};

export const processManifest = async (
  manifest: SN.AppManifest,
  forceWrite = false
): Promise<void> => {
  await processTablesInManifest(manifest.tables, forceWrite);
  await fUtils.writeFileForce(
    ConfigManager.getManifestPath(),
    JSON.stringify(manifest, null, 2)
  );
};

const markFileMissing = (missingObj: SN.MissingFileTableMap) => (
  table: string
) => (recordId: string) => (file: SN.File) => {
  if (!missingObj[table]) {
    missingObj[table] = {};
  }
  if (!missingObj[table][recordId]) {
    missingObj[table][recordId] = [];
  }
  const { name, type } = file;
  missingObj[table][recordId].push({ name, type });
};
type MarkTableMissingFunc = ReturnType<typeof markFileMissing>;
type MarkRecordMissingFunc = ReturnType<MarkTableMissingFunc>;
type MarkFileMissingFunc = ReturnType<MarkRecordMissingFunc>;

const markRecordMissing = (
  record: SN.MetaRecord,
  missingFunc: MarkRecordMissingFunc
) => {
  record.files.forEach(file => {
    missingFunc(record.sys_id)(file);
  });
};

const markTableMissing = (
  table: SN.TableConfig,
  tableName: string,
  missingFunc: MarkTableMissingFunc
) => {
  Object.keys(table.records).forEach(recName => {
    markRecordMissing(table.records[recName], missingFunc(tableName));
  });
};

const checkFilesForMissing = async (
  recPath: string,
  files: SN.File[],
  missingFunc: MarkFileMissingFunc
) => {
  const checkPromises = files.map(fUtils.SNFileExists(recPath));
  const checks = await Promise.all(checkPromises);
  checks.forEach((check, index) => {
    if (!check) {
      missingFunc(files[index]);
    }
  });
};

const checkRecordsForMissing = async (
  tablePath: string,
  records: SN.TableConfigRecords,
  missingFunc: MarkRecordMissingFunc
) => {
  const recNames = Object.keys(records);
  const recPaths = recNames.map(fUtils.appendToPath(tablePath));
  const checkPromises = recNames.map((recName, index) =>
    fUtils.pathExists(recPaths[index])
  );
  const checks = await Promise.all(checkPromises);
  const fileCheckPromises = checks.map(async (check, index) => {
    const recName = recNames[index];
    const record = records[recName];
    if (!check) {
      markRecordMissing(record, missingFunc);
      return;
    }
    await checkFilesForMissing(
      recPaths[index],
      record.files,
      missingFunc(record.sys_id)
    );
  });
  await Promise.all(fileCheckPromises);
};

const checkTablesForMissing = async (
  topPath: string,
  tables: SN.TableMap,
  missingFunc: MarkTableMissingFunc
) => {
  const tableNames = Object.keys(tables);
  const tablePaths = tableNames.map(fUtils.appendToPath(topPath));
  const checkPromises = tableNames.map((tableName, index) =>
    fUtils.pathExists(tablePaths[index])
  );
  const checks = await Promise.all(checkPromises);

  const recCheckPromises = checks.map(async (check, index) => {
    const tableName = tableNames[index];
    if (!check) {
      markTableMissing(tables[tableName], tableName, missingFunc);
      return;
    }
    await checkRecordsForMissing(
      tablePaths[index],
      tables[tableName].records,
      missingFunc(tableName)
    );
  });
  await Promise.all(recCheckPromises);
};

export const findMissingFiles = async (
  manifest: SN.AppManifest
): Promise<SN.MissingFileTableMap> => {
  const missing: SN.MissingFileTableMap = {};
  const { tables } = manifest;
  const missingTableFunc = markFileMissing(missing);
  await checkTablesForMissing(
    ConfigManager.getSourcePath(),
    tables,
    missingTableFunc
  );
  // missing gets mutated along the way as things get processed
  return missing;
};

export const processMissingFiles = async (
  newManifest: SN.AppManifest
): Promise<void> => {
  try {
    const missing = await findMissingFiles(newManifest);
    const filesToProcess = await SNClient.getMissingFiles(missing);
    await processTablesInManifest(filesToProcess, false);
  } catch (e) {
    throw e;
  }
};

export const getAppFilesInPath = async (
  path: string
): Promise<Sinc.FileContext[]> => {
  const filePaths = await fUtils.getPathsInPath(path);
  const fileCtxPromises = filePaths.map(fUtils.getFileContextFromPath);
  const maybeFileContexts = await Promise.all(fileCtxPromises);
  const fileContexts = maybeFileContexts.filter(
    (ctx): ctx is Sinc.FileContext => ctx !== undefined
  );
  return fileContexts;
};

const getAppFilesInPaths = async (
  paths: string[]
): Promise<Sinc.FileContext[]> => {
  const appFilePromises = paths.map(getAppFilesInPath);
  const appFileLists = await Promise.all(appFilePromises);
  return appFileLists.flat();
};

const countRecsInTree = (tree: Sinc.AppFileContextTree): number => {
  return Object.keys(tree).reduce((acc, table) => {
    return acc + Object.keys(tree[table]).length;
  }, 0);
};

export const groupAppFiles = (
  fileCtxs: Sinc.FileContext[]
): Sinc.AppFileContextTree => {
  const fillIfNotExists = (rec: Record<string, unknown>, key: string) => {
    if (!rec[key]) {
      rec[key] = {};
    }
  };
  return fileCtxs.reduce(
    (tree, cur) => {
      const { tableName, sys_id, targetField } = cur;
      fillIfNotExists(tree, tableName);
      fillIfNotExists(tree[tableName], sys_id);
      tree[tableName][sys_id][targetField] = cur;
      return tree;
    },
    {} as Sinc.AppFileContextTree
  );
};

export const buildRec = async (
  rec: Sinc.RecordContextMap
): Promise<Record<string, string>> => {
  const fields = Object.keys(rec);
  const buildPromises = fields.map(field => {
    return PluginManager.getFinalFileContents(rec[field]);
  });
  const builtFiles = await allSettled(buildPromises);
  const buildSuccess = !builtFiles.find(
    buildRes => buildRes.status === "rejected"
  );
  if (!buildSuccess) {
    throw new Error(
      aggregateErrorMessages(
        builtFiles
          .filter((b): b is Sinc.FailPromiseResult => b.status === "rejected")
          .map(b => b.reason),
        "Failed to build!",
        (_, index) => `${index}`
      )
    );
  }
  return builtFiles.reduce(
    (acc, buildRes, index) => {
      const { value: content } = buildRes as Sinc.SuccessPromiseResult<string>;
      const fieldName = fields[index];
      return { ...acc, [fieldName]: content };
    },
    {} as Record<string, string>
  );
};

export const summarizeRecord = (table: string, recDescriptor: string): string =>
  `${table} > ${recDescriptor}`;

const buildAndPush = async (
  table: string,
  tableTree: Sinc.TableContextTree,
  tick?: () => void
): Promise<Sinc.PushResult[]> => {
  const recIds = Object.keys(tableTree);
  const buildPromises = recIds.map(sysId => buildRec(tableTree[sysId]));
  const builtRecs = await allSettled(buildPromises);
  const client = clientFactory();
  const pushPromises = builtRecs.map(
    async (buildRes, index): Promise<Sinc.PushResult> => {
      const recMap = tableTree[recIds[index]];
      const recFields = Object.keys(recMap);
      const recDesc = recMap[recFields[0]].name || recIds[index];
      const recSummary = summarizeRecord(table, recDesc);
      if (buildRes.status === "rejected") {
        return {
          success: false,
          message: `${recSummary} : ${buildRes.reason.message}`
        };
      }
      try {
        const res = await retryOnErr(
          () => client.updateRecord(table, recIds[index], buildRes.value),
          PUSH_RETRY_LIMIT,
          PUSH_RETRY_WAIT,
          (numTries: number) => {
            logger.debug(
              `Failed to push ${recSummary}! Retrying with ${numTries} left...`
            );
          }
        );
        return processPushResponse(res, recSummary);
      } catch (e) {
        const errMsg = e.message || "Too many retries";
        return { success: false, message: `${recSummary} : ${errMsg}` };
      } finally {
        // this block always runs, even if we return
        if (tick) {
          tick();
        }
      }
    }
  );
  const pushResults = await Promise.all(pushPromises);
  return pushResults;
};

const getProgTick = (
  logLevel: string,
  total: number
): (() => void) | undefined => {
  if (logLevel === "info") {
    const progBar = new ProgressBar(":bar :current/:total (:percent)", {
      total,
      width: 60
    });
    return () => {
      progBar.tick();
    };
  }
  // no-op at other log levels
  return undefined;
};

export const getValidPaths = async (
  encodedPaths: string
): Promise<string[]> => {
  const pathChunks = encodedPaths
    .split(PATH_DELIMITER)
    .filter(p => p && p !== "");
  const pathExistsPromises = pathChunks.map(fUtils.pathExists);
  const pathExistsCheck = await Promise.all(pathExistsPromises);
  return pathChunks.filter((_, index) => pathExistsCheck[index]);
};

export const getFileTreeAndCount = async (
  encodedPaths: string
): Promise<[Sinc.AppFileContextTree, number]> => {
  const validPaths = await getValidPaths(encodedPaths);
  const appFileCtxs = await getAppFilesInPaths(validPaths);
  const appFileTree = groupAppFiles(appFileCtxs);
  const recordCount = countRecsInTree(appFileTree);
  return [appFileTree, recordCount];
};

export const pushFiles = async (
  appFileTree: Sinc.AppFileContextTree,
  recordCount: number
): Promise<Sinc.PushResult[]> => {
  const tick = getProgTick(logger.getLogLevel(), recordCount);
  const buildAndPushPromises = Object.keys(appFileTree).map(table =>
    buildAndPush(table, appFileTree[table], tick)
  );
  const tablePushResults = await Promise.all(buildAndPushPromises);
  return tablePushResults.flat();
};

export const swapScope = async (currentScope: string): Promise<SN.ScopeObj> => {
  try {
    const client = clientFactory();
    const scopeId = await processSimpleResponse(client.getScopeId(currentScope), "sys_id");
    await swapServerScope(scopeId);
    const scopeObj = await processSimpleResponse(client.getCurrentScope());
    return scopeObj;
  } catch (e) {
    throw e;
  }
};

const swapServerScope = async (scopeId: string): Promise<void> => {
  try {
    const client = clientFactory();
    const userSysId = await processSimpleResponse(client.getUserSysId(), "sys_id");
    const curAppUserPrefId = await processSimpleResponse(client.getCurrentAppUserPrefSysId(userSysId), "sys_id") || "";
    // If not user pref record exists, create it.
    if (curAppUserPrefId !== "")
      await client.updateCurrentAppUserPref(scopeId, curAppUserPrefId);
    else await client.createCurrentAppUserPref(scopeId, userSysId);
  } catch (e) {
    logger.error(e);
    throw e;
  }
};


/**
   * Creates a new update set and assigns it to the current user.
   * @param updateSetName - does not create update set if value is blank
   * @param skipPrompt - will not prompt user to verify update set name
   *
   */
  export const createAndAssignUpdateSet = async(
    updateSetName: string = ""
  ) => {
    logger.info(`Update Set Name: ${updateSetName}`);
      const client = clientFactory();
      const updateSetSysId = await processSimpleResponse(client.createUpdateSet(updateSetName), "sys_id");
      const userSysId = await processSimpleResponse(client.getUserSysId(), "sys_id");
      const curUpdateSetUserPrefId = await processSimpleResponse(client.getCurrentUpdateSetUserPref(userSysId), "sys_id");

      if (curUpdateSetUserPrefId !== "") {
        await client.updateCurrentUpdateSetUserPref(updateSetSysId, curUpdateSetUserPrefId);
      } else {
        await client.createCurrentUpdateSetUserPref(updateSetSysId, userSysId);
      }
      return {
        name: updateSetName,
        id: updateSetSysId
      }
  }

 export const checkScope = async(swap: boolean): Promise<Sinc.ScopeCheckResult>  => {
  try {
    let man = ConfigManager.getManifest();
    if (man) {
      let client = clientFactory();
      let scopeObj = await processSimpleResponse(client.getCurrentScope());
      if (scopeObj.scope === man.scope) {
        return {
          match: true,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope
        };
      } else if (swap) {
        const swappedScopeObj = await swapScope(man.scope);
        return {
          match: swappedScopeObj.scope === man.scope,
          sessionScope: swappedScopeObj.scope,
          manifestScope: man.scope
        };
      } else {
        return {
          match: false,
          sessionScope: scopeObj.scope,
          manifestScope: man.scope
        };
      }
    }
    //first time case
    return {
      match: true,
      sessionScope: "",
      manifestScope: ""
    };
  } catch (e) {
    throw e;
  }
}