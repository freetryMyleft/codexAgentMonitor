#!/bin/bash
set -euo pipefail
repository_dir="$(cd "$(dirname "$0")" && pwd)"
fail() { printf 'Agent Monitor: %s\n' "$*" >&2; exit 1; }

node_binary=""
if command -v node >/dev/null 2>&1; then node_binary="$(command -v node)"; fi
if [ -z "$node_binary" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_binary="$candidate"; break; fi
  done
fi
[ -n "$node_binary" ] || fail '需要 Node.js 20+；无需安装 npm 或手动编译。'
"$node_binary" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail '需要 Node.js 20+。'
python_binary=""
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' >/dev/null 2>&1; then
    python_binary="$candidate"; break
  fi
done
[ -n "$python_binary" ] || fail '需要 Python 3.10+。'
command -v codex >/dev/null 2>&1 || fail '需要 Codex CLI；安装后运行 codex plugin --help 检查支持。'
command -v tar >/dev/null 2>&1 || fail '需要系统 tar 命令。'

release_version="$("$node_binary" -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^\d+\.\d+\.\d+$/.test(p.version)) process.exit(1);process.stdout.write(p.version);' "$repository_dir/plugins/agent-monitor/package.json")"
archive_path="$repository_dir/releases/agent-monitor-$release_version.tar.gz"
[ -f "$archive_path" ] && [ -f "$archive_path.sha256" ] || fail '缺少预构建安装包及校验文件，请下载包含 releases/ 的完整发布版本。'
# Validate before invoking Codex or creating an installation directory.
"$node_binary" -e '
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
const archive=process.argv[1];const line=fs.readFileSync(archive+".sha256","utf8").trim();
const match=/^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(line);
if(!match||match[2]!==path.basename(archive)||crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")!==match[1].toLowerCase()){
console.error("SHA-256 校验失败：请重新下载安装包。");process.exit(1);}
' "$archive_path"
# Reject traversal, absolute paths, symlinks and special files, even for a
# checksum-valid local package. Releases only contain regular files/directories.
"$node_binary" -e '
const cp=require("node:child_process");const archive=process.argv[1];
const list=cp.spawnSync("tar",["-tzf",archive],{encoding:"utf8",maxBuffer:8*1024*1024});
const types=cp.spawnSync("tar",["-tvzf",archive],{encoding:"utf8",maxBuffer:8*1024*1024});
const safe=list.status===0&&types.status===0&&list.stdout.trim().split("\n").every(p=>p==="agent-monitor"||p.startsWith("agent-monitor/")&&!p.split("/").includes(".."))&&types.stdout.trim().split("\n").every(p=>p.startsWith("-")||p.startsWith("d"));
if(!safe){console.error("安装包包含不安全路径或非普通文件，拒绝安装。");process.exit(1);}
' "$archive_path"
codex plugin --help >/dev/null || fail '当前 Codex CLI 不支持插件命令。'

installation_base="${CODEX_HOME:-$HOME/.codex}/agent-monitor-installs"
mkdir -p "$installation_base"
installation_root="$(mktemp -d "$installation_base/install.XXXXXX")"
mkdir -p "$installation_root/plugins" "$installation_root/.agents/plugins"
tar -xzf "$archive_path" -C "$installation_root/plugins"
plugin_dir="$installation_root/plugins/agent-monitor"
"$node_binary" -e '
const fs=require("node:fs");const root=process.argv[1],expected=process.argv[2];
const manifest=JSON.parse(fs.readFileSync(root+"/plugins/agent-monitor/.codex-plugin/plugin.json","utf8"));
if(manifest.name!=="agent-monitor"||manifest.version!==expected) throw new Error("安装包版本与发布声明不一致。");
fs.writeFileSync(root+"/.agents/plugins/marketplace.json",JSON.stringify({name:"agent-monitor-local",interface:{displayName:"Agent Monitor · 本地插件"},plugins:[{name:"agent-monitor",source:{source:"local",path:"./plugins/agent-monitor"},policy:{installation:"AVAILABLE",authentication:"ON_INSTALL"},category:"Productivity"}]},null,2)+"\n");
' "$installation_root" "$release_version"

# Probe only discovery and the UI resource, never live conversations.
"$node_binary" "$plugin_dir/doctor.mjs" "$plugin_dir"
previous_source="$("$node_binary" -e '
const cp=require("node:child_process"),fs=require("node:fs"),path=require("node:path");
try {
 const result=cp.spawnSync("codex",["plugin","marketplace","list","--json"],{encoding:"utf8"});
 if(result.status!==0) throw new Error("无法检查已有插件市场。");
 const data=JSON.parse(result.stdout);if(!Array.isArray(data.marketplaces)) throw new Error("插件市场返回格式不正确。");
 const entries=data.marketplaces.filter(m=>m.name==="agent-monitor-local");
 if(entries.length>1) throw new Error("同名插件市场不唯一，请先检查配置。");
 if(entries.length) {
  const m=entries[0],source=m.marketplaceSource;
  if(source?.sourceType!=="local"||typeof source.source!=="string"||!path.isAbsolute(source.source)||/[\r\n]/.test(source.source)) throw new Error("已有同名市场不是可安全升级的本地来源。");
  const manifest=JSON.parse(fs.readFileSync(path.join(source.source,".agents/plugins/marketplace.json"),"utf8"));
  if(manifest.name!=="agent-monitor-local"||manifest.plugins?.length!==1||manifest.plugins[0].name!=="agent-monitor") throw new Error("同名市场包含其他插件，停止自动升级。");
  process.stdout.write(source.source);
 }
} catch(error) {console.error(error.message);process.exit(1);}
')"
if [ -n "$previous_source" ]; then
  codex plugin marketplace remove agent-monitor-local --json
fi
if ! codex plugin marketplace add "$installation_root" --json; then
  if [ -n "$previous_source" ]; then codex plugin marketplace add "$previous_source" --json >&2; fi
  fail '新市场登记失败，已尝试恢复旧来源；安装目录和旧文件均保留。'
fi
if ! codex plugin add agent-monitor@agent-monitor-local --json; then
  if [ -n "$previous_source" ]; then
    codex plugin marketplace remove agent-monitor-local --json >&2
    codex plugin marketplace add "$previous_source" --json >&2
  fi
  fail '插件安装失败，旧来源已尝试恢复；安装目录保留供检查。'
fi
printf '\n安装完成：Agent Monitor %s（无需 npm 或编译）。\n' "$release_version"
printf '诊断命令："%s" "%s/doctor.mjs" "%s"\n' "$node_binary" "$plugin_dir" "$plugin_dir"
printf '重开客户端后检查入口；插件列表可见不代表客户端支持全局侧边栏。\n'
printf '浏览器备用入口："%s" "%s/preview-runtime.mjs"（打开打印的本机地址）。\n' "$node_binary" "$plugin_dir"
printf '保留的独立安装目录：%s\n' "$installation_root"
