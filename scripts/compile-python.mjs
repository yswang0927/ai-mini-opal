// @ts-check
/**
 * compile-python.mjs —— electron-builder afterPack 钩子。
 *
 * 目的:保护 python 业务代码。把已打包进 resources 的 python/server 下的 .py
 * 编译成 sourceless .pyc(字节码放回源文件位置、删掉 .py、清掉 __pycache__),
 * 让安装目录里看不到明文源码。
 *
 * 只作用于「打包产物副本」,绝不触碰仓库里的开发源码树。
 *
 * 重要例外:skills/ 整个目录保留 .py 明文 —— 这些脚本在运行时由 opal_skills.py
 * 以 `sys.executable <path.py>` 子进程方式动态执行(见 opal_skills.py run_skill_script),
 * 编译成 .pyc 会破坏这种「运行时读取 .py 执行」的模式。
 *
 * 注意:这是「提高门槛」而非加密。.pyc 仍可被反编译还原,只是挡住随手翻看源码。
 * 另:.env / *.md / 词表等非 .py 文件不受影响,若含密钥仍是明文,应另行处理。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** skills 目录名 —— 该目录下的 .py 必须保留明文,不编译。 */
const SKILLS_DIRNAME = 'skills';

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function afterPack(context) {
  const { appOutDir, packager } = context;
  const platform = packager.platform.name; // 'mac' | 'windows' | 'linux'

  // 定位打包后的 resources 目录(不同平台布局不同)。
  const resourcesDir =
    platform === 'mac'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');

  const serverDir = path.join(resourcesDir, 'python', 'server');
  if (!existsSync(serverDir)) {
    console.log(`[compile-python] 跳过:未找到 ${serverDir}`);
    return;
  }

  // 用「随包捆绑的」python 解释器来编译,保证字节码版本(magic number)与运行时一致。
  const runtimeDir = path.join(resourcesDir, 'python');
  const pythonExe =
    platform === 'windows'
      ? path.join(runtimeDir, 'python.exe')
      : path.join(runtimeDir, 'bin', 'python3');

  if (!existsSync(pythonExe)) {
    throw new Error(`[compile-python] 找不到捆绑解释器:${pythonExe}`);
  }

  console.log(`[compile-python] 编译 ${serverDir}(排除 ${SKILLS_DIRNAME}/)`);

  const packScript = path.join(__dirname, 'pyc_pack.py');
  const result = spawnSync(pythonExe, [packScript, serverDir, SKILLS_DIRNAME], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`[compile-python] 编译失败,退出码 ${result.status}`);
  }
  console.log('[compile-python] 完成');
}
