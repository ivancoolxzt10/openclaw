// 本文件是一个简单的再导出（re-export）文件。
// 它从一个更深层的工具模块 (`../infra/prototype-keys.js`) 导入 `isBlockedObjectKey` 函数，
// 并将其作为 `config` 目录公共 API 的一部分导出。
//
// `isBlockedObjectKey` 函数的目的是为了防止“原型链污染（Prototype Pollution）”漏洞。
// 这是一种在 JavaScript 中常见且危险的漏洞。该函数会检查一个给定的键名是否是
// `__proto__`、`prototype` 或 `constructor` 之一。
//
// 如果处理对象合并或克隆的代码没有明确阻止这些特殊键名，攻击者可能会构造一个恶意的
// JSON 数据（例如 `{"__proto__": {"isAdmin": true}}`），这可能导致应用程序中的所有对象
// 都意外地拥有 `isAdmin: true` 属性，从而引发严重的安全问题。
//
// 通过将此检查集中在一个函数中并在此处重新导出，应用程序确保了所有处理配置的代码
// 都能方便地使用同一个、健壮的安全检查。

export { isBlockedObjectKey } from "../infra/prototype-keys.js";
