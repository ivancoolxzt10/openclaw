// 本文件是 `config` 目录的入口（index）文件。
// 它本身不包含任何业务逻辑，其主要作用是作为该目录的公共 API。
// 它从目录中的其他模块（例如 `io.js`, `legacy-migrate.js` 等）导入函数、类型和常量，
// 然后再将它们重新导出。
//
// 这种模式的好处是：
// 1. **封装**: 它隐藏了 `config` 目录内部的文件结构，其他模块只需要从这一个文件导入即可。
// 2. **易于维护**: 如果内部文件被重命名或重构，只需要更新这个文件的导出语句，而不需要修改所有引用了这些功能的文件。

export {
  clearConfigCache,
  ConfigRuntimeRefreshError,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  loadConfig,
  readBestEffortConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
export { migrateLegacyConfig } from "./legacy-migrate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export {
  validateConfigObject,
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
