/**
 * useAutoSave —— 自动保存 hook
 *
 * 注意：Ctrl+S 手动保存在 App.tsx 中处理，此处只处理定时自动保存
 *
 * 核心修复：根据当前 viewMode 选择正确的数据源
 * - 阅读模式：从 ProseMirror doc 序列化（doc 是最新的）
 * - 编辑/分屏模式：从 sourceContent 读取（textarea 是最新的，ProseMirror doc 可能未同步）
 *
 * 性能优化：优先使用 docToMarkdown 缓存，避免重复序列化
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v0.13.0 返修（问题⑭：「自动保存好像失效了」）
 *
 * ## 缺陷根因（一）：定时器是一次性的，而续期依赖 React 依赖重跑
 *
 * 旧实现是一个「effect 内一次性 setTimeout」：
 *
 *   useEffect(() => {
 *     if (!isDirty || !filePath || ...) return;
 *     timerRef.current = setTimeout(save, autoSaveInterval);   // 只排一次
 *   }, [isDirty, autoSaveInterval, save, filePath, suppressAutoSave, externallyChanged]);
 *
 * 只要一次保存尝试**没有把 isDirty 清成 false**，依赖数组里的值就不会变（用户继续
 * 打字时 isDirty 恒为 true），effect 不重跑 → 定时器不再续期。三条「没保存成功但
 * 也没清脏」的路径都会把自动保存**永久**杀死：
 *   ① 三路判定 conflict（本次写盘被放弃）；
 *   ② `fileService.writeFile` 抛错（旧 catch 里只 console.error，脏标记原样保留）；
 *   ③ 顶部 `if (externallyChanged) return;` 早退。
 * 后果：本会话内自动保存再也不触发，只有「用户手动保存（isDirty→false）后再编辑」
 * 才会重新武装 —— 这正是用户报告的「自动保存好像失效了」。
 *
 * 修复：定时器改为**自续期循环**。每一轮结束后按 store 的实时状态决定是否续期，
 * 与 React 依赖重跑解耦。冲突 / skip / 写盘失败都不会再让循环停摆。
 *
 * ## 缺陷根因（二）：暂停态不自愈
 *
 * 判定 conflict 时会 `setTabExternallyChanged(true)`，此后旧实现永远在
 * `if (externallyChanged) return;` 处早退；**即使磁盘后来被证明并没有被第三方改过**
 * （watcher 误报、外部程序把内容改回原样、另一窗口的保存其实是空操作）也不会恢复，
 * 于是「一次误报 = 自动保存永久暂停」，并一直挂着「已被外部修改」徽标。
 *
 * 修复：处于暂停态时，每一轮先**复核磁盘**（自愈）——用与写盘前完全相同的三路判定
 * 证明「磁盘未被第三方改过」就清除暂停标记并在本轮继续保存；证明不了（真分叉 /
 * 读盘失败 / 无基线可证）则保持暂停、绝不写盘。安全边界不变：
 * **外部修改永远不会被自动保存静默覆盖**。
 * ─────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useCallback } from "react";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService, isTauri } from "../services/fileService";
import { versionSnapshotService } from "../services/versionSnapshotService";
import { getKnownDiskContent } from "../services/selfWriteGuard";
import {
  judgeAutoSaveWrite,
  getCachedDiskRead,
  putCachedDiskRead,
} from "../utils/autoSaveGuard";
import { safeSetItem } from "../utils/safeStorage";
import { getMarkdownFromDoc } from "../core/editor";
import { isMarkdownFile } from "../utils/constants";
import { preserveEol } from "../utils/eolPreserve";
import { useT } from "../i18n";
import type { EditorView } from "prosemirror-view";

/** 从路径取文件名（用于提示文案；与 App.tsx 的同名工具保持一致行为） */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 当前标签是否处于「外部变更未处理」暂停态（每轮从 store 实时读取，避免闭包陈旧） */
function isActiveTabPaused(): boolean {
  const s = useEditorStore.getState();
  return s.openTabs[s.activeTabIdx]?.isExternallyChanged === true;
}

/**
 * 文档是否仍需自动保存（脏 + 有路径 + 未被翻译回写抑制）。
 *
 * 这是**自续期循环的续期条件**：直接读 store 实时状态，因此不受 React 依赖数组
 * 是否变化影响 —— 修复「保存没成功 → effect 不重跑 → 定时器永不续期」。
 */
function shouldKeepSaving(): boolean {
  const s = useEditorStore.getState();
  return s.isDirty && !!s.filePath && !s.suppressAutoSave;
}

/**
 * v0.13.1 需求14：捕获时记录的路径是否**仍然是当前活动路径**。
 *
 * 自动保存的每一轮都要跨多个 `await`（读盘、写盘），期间用户完全可能切换标签。
 * 任何"路径已变"的时刻都必须整轮放弃——否则会把 A 的磁盘与 B 的内容放在一起判定。
 */
function isStillActivePath(path: string): boolean {
  return useEditorStore.getState().filePath === path;
}

/**
 * v0.13.1 需求14：按**路径**取标签下标。
 *
 * 不能用 `activeTabIdx`：它是在 await 之前读的，跨 await 后可能已经指向别的标签，
 * 于是"给这个文件标外部变更"会标到用户刚切过去的另一个文件上（误报的直接来源）。
 *
 * @returns 标签下标；标签已关闭 / 不存在时 -1
 */
function tabIndexOf(path: string): number {
  try {
    return useEditorStore.getState().getTabByPath(path);
  } catch {
    return -1;
  }
}

export function useAutoSave(
  viewRef: React.MutableRefObject<EditorView | null>,
  // 源码模式下的最新内容（编辑/分屏模式使用），通过 ref 传入避免闭包陈旧
  sourceContentRef?: React.MutableRefObject<string>
) {
  const filePath = useEditorStore((s) => s.filePath);
  const isDirty = useEditorStore((s) => s.isDirty);
  // v0.6.1 问题3：翻译回写（直接替换/双语对照）的修改不自动保存，等待用户手动保存或继续编辑
  const suppressAutoSave = useEditorStore((s) => s.suppressAutoSave);
  const setDirty = useEditorStore((s) => s.setDirty);
  const updateTabDirty = useEditorStore((s) => s.updateTabDirty);
  const viewMode = useEditorStore((s) => s.viewMode);
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveIntervalMs);
  const t = useT();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * v0.13.0 返修（问题⑭）根因三：把会「每次渲染都换身份」的 ref 参数转存到自身的 ref。
   *
   * 背景：`EditorContainer` 传入的 `autoSaveSourceRef` 是**每次渲染都新建的对象字面量**
   * （为了用 getter 拦截读取做 base64 unmask，见 EditorContainer.tsx:640），
   * 于是 `sourceContentRef` 这个 prop 的身份**每次渲染都变**。而 EditorContainer 在
   * 用户每次击键时都会重渲染 → `currentMarkdown` / `save` 的 useCallback 依赖变化
   * → `save` 身份每次击键都变 → 定时 effect 每次击键都被「清理 + 重建」。
   *
   * 后果：定时器被不断重置，自动保存退化成「停手后 N 秒才保存的防抖」——
   * 只要用户连续输入超过一个间隔（默认 60s），**自动保存永远不会触发**；
   * 停手后若一次保存因冲突失败，定时器又不再续期（根因一），于是彻底失效。
   *
   * 修复：只保存 ref 本身（身份稳定），在调用时再读 `.current`，让 `save` 与定时
   * effect 不再随击键重建。这样定时器恢复「按固定周期反复触发」的语义。
   */
  const sourceContentRefRef = useRef(sourceContentRef);
  sourceContentRefRef.current = sourceContentRef;
  /**
   * v0.9.0 第五轮（问题1）：当前标签是否「已被**其他**窗口保存过而未处理」。
   *
   * 多窗口同文件同时编辑时，后台定时自动保存**静默覆盖**另一个窗口刚保存的内容
   * 是最真实的数据丢失点（用户完全不知情）。因此此处暂停自动保存，并要求用户
   * 手动 `Ctrl+S`——手动保存会走「覆盖 / 另存为 / 取消」确认，知情后才会覆盖。
   *
   * 磁盘内容始终以「最后一次成功保存」为准；暂停只保证**没有哪一次覆盖是静默的**。
   *
   * v0.13.0 返修（问题⑭）：该订阅现在**只**驱动下面的暂停提示 effect；
   * 定时循环不再把它当作停止条件，而是每轮实时读取 + 复核磁盘自愈。
   */
  const externallyChanged = useEditorStore(
    (s) => s.openTabs[s.activeTabIdx]?.isExternallyChanged === true,
  );
  /** 暂停提示只弹一次（同一轮外部变更内），用户手动保存清除标记后重新武装 */
  const pausedNotifiedRef = useRef(false);
  // 用 ref 追踪 viewMode，避免 save 函数频繁重建
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  /**
   * 取「本次要写入磁盘的内容」。
   *
   * 数据源选择：
   * - 编辑/分屏模式：textarea 内容是最新的（ProseMirror doc 尚未同步）
   * - 阅读模式：ProseMirror doc 是最新的
   * - 非 md 文件：ProseMirror 始终为空（Issue 7 隐藏 bug），无论什么模式都必须
   *   从 sourceContentRef 读取，否则会保存空内容
   *
   * 抽成独立函数是为了让「暂停态自愈复核」与 `save()` 使用**同一份**目标内容，
   * 避免两处各算一遍导致判定基准漂移。
   *
   * v0.13.1 需求14：**路径改为显式入参**（不再从闭包读 `filePath`）。
   *
   * 缺陷背景：`filePath` 是闭包变量（创建本回调那次渲染的值），而函数体实时读取
   * `viewRef.current` / `sourceContentRef`（当前显示的文件）。一次跨标签切换的
   * 自动保存轮次里两者会分叉 → 拿 A 的路径配 B 的内容。改成显式入参后，
   * "取内容"与"判定/写盘"用的是**同一个路径**，调用方还必须在每个 await 之后校验
   * 它仍是活动路径（见 `isStillActivePath`）。
   *
   * `viewRef` 本身是稳定 ref（父组件用 useRef 创建），沿用既有做法直接读取。
   *
   * @param path 本轮操作针对的文件路径（必须是捕获到的快照值，不是实时值）
   * @returns 目标内容；无视图或无路径时返回 null（此时不该发生任何写盘）
   */
  const currentMarkdown = useCallback((path: string | null): string | null => {
    const view = viewRef.current;
    const sourceRef = sourceContentRefRef.current;
    if (!view || !path) return null;
    const isSourceMode = viewModeRef.current === "edit" || viewModeRef.current === "split";
    const isMdFile = isMarkdownFile(path);
    if ((isSourceMode || !isMdFile) && sourceRef?.current !== undefined) {
      return sourceRef.current;
    }
    // 优先使用缓存的序列化结果，避免重复计算
    let markdown = getMarkdownFromDoc(view.state.doc);
    // v0.9.0 D7：CRLF 文档的序列化输出统一转回 CRLF（B6 快路径已逐字节
    // 返回原文不受影响，此处兜底重新序列化的块）
    if (sourceRef?.current) {
      markdown = preserveEol(markdown, sourceRef.current);
    }
    return markdown;
    // viewRef / viewModeRef / sourceContentRefRef 是稳定 ref，不应出现在依赖里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * v0.13.0 返修（问题⑭）：暂停态自愈复核。
   *
   * 背景：判定 conflict 后会标记 `isExternallyChanged`，旧实现在此永久早退——
   * 哪怕磁盘后来被证明**并没有**被第三方改过（watcher 误报 / 外部程序改回原样 /
   * 另一窗口的保存其实是空操作），也不会恢复，用户只能手动 Ctrl+S。
   *
   * 做法：用与写盘前**完全相同**的三路判定复核一次磁盘。
   * - `write`（磁盘 === 本应用所知的磁盘状态）→ 之前的冲突已不存在 → 解除暂停；
   * - `skip`（磁盘 === 本次目标内容）→ 内容已一致，写盘本就是空操作 → 解除暂停；
   * - `conflict`（真分叉 / 读盘失败 / 无基线可证）→ **保持暂停**，绝不写盘。
   *
   * @returns true = 已解除暂停（调用方可在本轮继续保存）
   */
  const healPausedIfDiskUnchanged = useCallback(
    async (path: string): Promise<boolean> => {
      let disk: string;
      try {
        disk = await fileService.readFile(path, { silent: true });
      } catch {
        // 读盘失败（被删/被锁/权限）→ 无从证明磁盘未被改过，保守保持暂停
        return false;
      }
      // v0.13.1 需求14：读盘期间可能已切换标签 → 本轮的"暂停复核"不再属于当前文件，
      // 必须放弃（否则会把另一个文件的暂停标记按本文件的磁盘状态解除）。
      if (!isStillActivePath(path)) return false;
      const target = currentMarkdown(path);
      if (target === null) return false;
      const decision = judgeAutoSaveWrite({
        diskContent: disk,
        targetContent: target,
        lastSelfWritten: getKnownDiskContent(path),
      });
      if (decision === "conflict") return false;
      // 读盘结果顺手入缓存：本轮随后的 save() 直接复用，避免同一 tick 打两次磁盘
      putCachedDiskRead(path, disk, Date.now());
      // 按**路径**定位标签（不能用可能过期的 activeTabIdx）
      const idx = tabIndexOf(path);
      if (idx < 0) return false;
      useEditorStore.getState().setTabExternallyChanged(idx, false);
      return true;
    },
    [currentMarkdown],
  );

  const save = useCallback(async () => {
    // ─── v0.13.1 需求14：把本轮操作**绑定到一个 (路径, 内容) 快照**上 ───────────
    //
    // 缺陷背景（用户报告「打开多个文件在编辑，切换不同文件时还是会提示某某文件
    // 已在其他窗口保存，自动保存暂停」）：
    // 旧实现同时使用三个**不同时刻**的状态——
    //   · `filePath` 来自本 useCallback 的闭包（= 创建它那次渲染时的文件）；
    //   · `currentMarkdown()` 实时读取 `viewRef.current` / `sourceContentRef`
    //     （= **当前显示**的文件）；
    //   · `activeTabIdx` 在本函数开头从 store 实时读取（= **当前活动**标签）。
    // 一轮 tick 如果在 `await fileService.readFile(...)` 期间发生标签切换，
    // 三者的指向就分叉，造成两种后果：
    //   ① 用「A 的磁盘」比「B 的内容」→ 既不等于磁盘也不等于基线 → 判 conflict →
    //      把用户**刚切过去的 B** 标成「外部变更」→ 弹
    //      「「B」已在其他窗口保存，自动保存已暂停」——而 B 从未被任何外部程序改过；
    //   ② 更危险：「A 的磁盘 == A 的基线」时判定为 write，随后
    //      `writeFile(A, markdown)` 会把 **B 的内容写进 A**（静默跨文件覆盖）。
    //
    // 修复：入口一次性捕获 `path`，全程只用这个值；每个 `await` 之后重新校验
    // 它仍是当前活动路径，一旦不是就**整轮放弃**（不判定、不写盘、不改任何状态）。
    const path = filePath;
    if (!path) return;
    if (!isStillActivePath(path)) return;
    const markdown = currentMarkdown(path);
    if (markdown === null) return;

    try {
      if (isTauri()) {
        // v0.13.0 需求3：写盘前先读一次磁盘做三路判定。
        //
        // 背景：外部软件改文件、而 LightMD 正开着它时，若直接写盘会把内存里的
        // 旧内容盖回去，外部编辑被静默覆盖回退（用户完全不知情）。
        // 此前的 `externallyChanged` 标记不够——它依赖 watcher 事件先到达，
        // 而事件可能因「目录未挂载 / mtime 去重命中 / Rust 回调调度晚于定时器」
        // 迟到或缺失。所以这里不依赖事件，直接自己读盘判断。
        const now = Date.now();
        let disk = getCachedDiskRead(path, now);
        if (disk === undefined) {
          disk = await fileService.readFile(path, { silent: true });
          putCachedDiskRead(path, disk, now);
        }
        // 读盘期间可能已切换标签 → 本轮作废（否则会用别的文件的内容做判定）
        if (!isStillActivePath(path)) return;
        const decision = judgeAutoSaveWrite({
          diskContent: disk,
          targetContent: markdown,
          // v0.13.0 返修（问题8）：这里必须用「本应用所知的磁盘内容」——
          // 优先自身写盘记录（短 TTL），否则回退打开文件时登记的磁盘基线（长 TTL）。
          //
          // 缺陷背景：此前用 `getLastSelfWritten`（TTL 仅 10s），而自动保存默认间隔
          // 是 **60s**。于是「打开文件 → 编辑 → 从未手动保存」或「上次保存已过 10s」
          // 时，该函数返回 null → 三路判定无法证明磁盘未被第三方改过 → 判为 conflict
          // → 放弃自动保存并弹「已在其他窗口保存，自动保存已暂停」。
          // 实际**没有任何外部程序改过文档**，这就是用户报告的误报。
          lastSelfWritten: getKnownDiskContent(path),
        });
        if (decision === "conflict") {
          // 第三方已改过磁盘 → 放弃本次自动保存，绝不写盘。
          // 标记「外部变更未处理」并提示：用户手动 Ctrl+S 时会走
          // 「覆盖 / 另存为 / 取消」确认（知情后才会覆盖）。
          // v0.13.1 需求14：**按路径定位标签**，不按可能已过期的 activeTabIdx
          // （否则会把暂停标记打到用户刚切过去的另一个文件上，就是那条误报）。
          const idx = tabIndexOf(path);
          if (idx < 0) return; // 标签已关闭 → 无处可标，安静结束
          const alreadyMarked =
            useEditorStore.getState().openTabs[idx]?.isExternallyChanged === true;
          useEditorStore.getState().setTabExternallyChanged(idx, true);
          // v0.13.0 返修（问题⑭）：只在**首次**判定冲突时提示。
          // 暂停期间定时循环每轮都会复核磁盘，若每轮都弹同一条会刷屏；
          // 「自动保存已暂停」那条由下面的提示 effect 负责（每轮暂停只弹一次）。
          if (!alreadyMarked) {
            void import("../services/notificationService").then(({ notify }) =>
              notify(t("multiwindow.autoSaveSkipped", { name: fileNameOf(path) }), "warning"),
            );
          }
          return;
        }
        if (decision === "skip") {
          // 磁盘已是目标内容：无需写盘，直接清脏标记（省一次 IO + 一次快照）
          //
          // v0.13.1 需求14：`setDirty(false)` 是**全局活动标签**的脏标记，
          // 只要本轮的 path 仍等于活动路径（前面已校验）就应当清掉；
          // 只有"逐标签"的更新需要有效的下标，故下标缺失时不得连全局标记一起跳过
          // （那会让自动保存"保存了但小蓝点不消失"）。
          setDirty(false);
          const idx = tabIndexOf(path);
          if (idx >= 0) {
            updateTabDirty(idx, false);
            // 磁盘已等于目标内容 ⇒ 不存在「未处理的外部变更」，顺手清掉暂停标记（自愈）
            useEditorStore.getState().setTabExternallyChanged(idx, false);
          }
          return;
        }
        // ─── 写盘前的**最后一次**校验：路径没变才允许落盘 ───
        // 这是防「把 B 的内容写进 A」的最后一关（判定与写盘之间还有一次 await 的机会窗）。
        if (!isStillActivePath(path)) return;
        await fileService.writeFile(path, markdown);
        // 写盘期间又切走了：内容已经写进 path（正确），但**不要再动状态标记**——
        // 那些标记是给"当前活动标签"用的，此时活动标签已经是别人了。
        if (!isStillActivePath(path)) return;
        // v0.4.0 功能4：自动保存成功后记录版本快照（内容去重由服务内部处理）
        versionSnapshotService.recordSnapshot(path, markdown).catch(() => {});
      } else {
        safeSetItem("lightmd-content", markdown);
      }
      // 同上：全局脏标记必清；逐标签更新按需。
      setDirty(false);
      const savedIdx = tabIndexOf(path);
      if (savedIdx >= 0) {
        updateTabDirty(savedIdx, false);
        // v0.13.0 返修（问题⑭）：写盘成功后磁盘就是本应用的内容 ⇒ 解除暂停标记。
        // 这也是自愈的一环：暂停期间若磁盘恢复到可写状态，下一次写盘即恢复正常。
        useEditorStore.getState().setTabExternallyChanged(savedIdx, false);
      }
    } catch (err) {
      console.error("[AutoSave] 保存失败:", err);
      // v0.13.0 返修（问题⑭）：写盘失败不再等于「自动保存结束」——
      // 脏标记保留，定时循环会在下一个间隔自动重试（见下方自续期循环）。
    }
    // v0.13.1 需求14：不再依赖 `filePath` —— 路径已改为入口快照，
    // 故 `save` 的身份不再随切换标签而变（定时循环只在 filePath 变化时重建）。
  }, [currentMarkdown, filePath, setDirty, updateTabDirty, t]);

  /**
   * v0.13.0 返修（问题⑭）：定时自动保存改为**自续期循环**。
   *
   * 旧实现是「effect 内一次性 setTimeout」，续期完全依赖 effect 重跑；而 effect 的
   * 依赖（isDirty 等）在「保存没成功」时根本不会变 → 循环停摆（根因一）。
   *
   * 现在：每轮结束后由 `shouldKeepSaving()` 按 **store 实时状态**决定是否排下一轮，
   * 与 React 依赖无关。于是
   * - conflict：本轮不写盘，但循环继续 → 下一轮再次复核磁盘（自愈，根因二）；
   * - writeFile 抛错：脏标记保留，循环继续 → 下一个间隔自动重试；
   * - skip / 写盘成功：isDirty→false → 循环自然停止（无空转）；
   * - 换文件 / 无路径 / 翻译回写抑制 / 关闭自动保存：循环停止。
   *
   * 注意 `externallyChanged` **不再**出现在依赖数组里：暂停与否现在由每轮实时读取
   * store 决定（暂停态也要继续跑复核），而不是让 effect 重启或永久早退。
   */
  useEffect(() => {
    if (!isDirty || !filePath || autoSaveInterval <= 0 || suppressAutoSave) return;
    let disposed = false;

    /** 单轮：暂停态先复核磁盘自愈；仍暂停则不写盘，但**不终止循环** */
    const tick = async (): Promise<void> => {
      if (!shouldKeepSaving()) return;
      // v0.13.1 需求14：本轮同样以**入口快照**的路径为準，并在每个 await 之后复核。
      const path = useEditorStore.getState().filePath;
      if (!path) return;
      // 本轮开始时标签是否处于「外部变更未处理」暂停态
      let externallyChanged = isActiveTabPaused();
      if (externallyChanged) {
        // 暂停态：先复核磁盘（自愈路径）——证明磁盘未被第三方改过就解除暂停并继续保存
        externallyChanged = !(await healPausedIfDiskUnchanged(path));
        // 复核期间切换了标签 → 本轮不再属于当前文件，直接结束（下一轮会重排）
        if (!isStillActivePath(path)) return;
      }
      // 复核后仍是「外部变更未处理」→ 放弃**本轮**写盘（绝不覆盖外部编辑）。
      // 与 v0.9.0 的语义一致：外部变更未处理时自动保存必须让路。
      // 区别在于这不再是永久早退——本轮结束后仍会续期，下一轮再次复核磁盘。
      if (externallyChanged) return;
      await save();
    };

    const arm = () => {
      if (disposed) return;
      timerRef.current = setTimeout(() => {
        void tick()
          .catch(() => undefined)
          .finally(() => {
            // 关键修复：无论本轮结果如何都按实时状态续期——冲突 / skip / 写盘失败
            // 都不会再让自动保存永久停摆
            if (shouldKeepSaving()) arm();
          });
      }, autoSaveInterval);
    };

    arm();
    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isDirty, autoSaveInterval, save, filePath, suppressAutoSave, healPausedIfDiskUnchanged]);

  /**
   * v0.9.0 第五轮：自动保存暂停的一次性提示。
   *
   * 只在「确实开着自动保存 + 本窗口有未保存修改」时提示——否则用户本就该收到
   * App 侧那条 `fileChanged.dirtyHint`，不必重复打扰。
   */
  useEffect(() => {
    if (!externallyChanged) {
      pausedNotifiedRef.current = false;
      return;
    }
    if (autoSaveInterval <= 0 || !isDirty || pausedNotifiedRef.current) return;
    pausedNotifiedRef.current = true;
    void import("../services/notificationService").then(({ notify }) =>
      notify(t("multiwindow.autoSavePaused", { name: fileNameOf(filePath ?? "") }), "warning"),
    );
  }, [externallyChanged, autoSaveInterval, isDirty, filePath, t]);

  return { save };
}
