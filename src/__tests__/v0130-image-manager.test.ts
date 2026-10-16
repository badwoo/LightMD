/**
 * v0.13.0 需求11：图片管理面板 —— 纯函数层测试
 *
 * 覆盖三个操作的计算部分：
 * - collectDocImages：同 src 合并计数 + 首次出现的 alt/width/align 语义
 * - planAssetsMigration / resolveUniqueFileName：目标文件名冲突消解 + 新引用形态
 * - findUnreferenced：磁盘文件与本文档引用的差集（**只算当前文档**）
 * - planRename：保留原目录前缀的重命名引用
 */
import { describe, it, expect } from "vitest";
import {
  collectDocImages,
  isExternalImageSrc,
  imageFileNameOf,
  resolveUniqueFileName,
  planAssetsMigration,
  findUnreferenced,
  planRename,
  countRefsOf,
  revealTargetOf,
} from "../utils/imageManager";
import { markdownToDoc } from "../core/markdown/parser";

describe("v0.13.0 需求11 collectDocImages", () => {
  it("单张图片 → 计数 1", () => {
    const doc = markdownToDoc("![图](./assets/a.png)\n");
    const imgs = collectDocImages(doc);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].src).toBe("./assets/a.png");
    expect(imgs[0].alt).toBe("图");
    expect(imgs[0].count).toBe(1);
    expect(imgs[0].nodeCount).toBe(1);
    expect(imgs[0].width).toBeNull();
    expect(imgs[0].align).toBe("left");
  });

  it("同一 src 多处引用 → 合并为一条并计数", () => {
    const doc = markdownToDoc(
      "![一](./assets/a.png)\n\n![二](./assets/a.png)\n\n![三](./assets/b.png)\n",
    );
    const imgs = collectDocImages(doc);
    expect(imgs).toHaveLength(2);
    expect(imgs[0].src).toBe("./assets/a.png");
    expect(imgs[0].count).toBe(2);
    expect(imgs[0].nodeCount).toBe(2);
    // 首个非空 alt 生效（"一"）
    expect(imgs[0].alt).toBe("一");
    expect(imgs[1].src).toBe("./assets/b.png");
    expect(imgs[1].count).toBe(1);
  });

  it("宽度与对齐后缀被解析并记录（v0.13.0 需求4 语法同源）", () => {
    const doc = markdownToDoc("![图|300|center](./assets/a.png)\n");
    const imgs = collectDocImages(doc);
    expect(imgs[0].width).toBe(300);
    expect(imgs[0].align).toBe("center");
  });

  it("宽度后缀不污染 alt", () => {
    const doc = markdownToDoc("![图|300](./assets/a.png)\n");
    const imgs = collectDocImages(doc);
    expect(imgs[0].alt).toBe("图");
    expect(imgs[0].width).toBe(300);
  });

  it("alt 本身含竖线不被误判为宽度/对齐", () => {
    const doc = markdownToDoc("![a|b](./assets/a.png)\n");
    const imgs = collectDocImages(doc);
    expect(imgs[0].alt).toBe("a|b");
    expect(imgs[0].width).toBeNull();
  });

  it("空 alt 被后一个非空 alt 补齐", () => {
    const doc = markdownToDoc("![](./assets/a.png)\n\n![有名字](./assets/a.png)\n");
    const imgs = collectDocImages(doc);
    expect(imgs[0].count).toBe(2);
    expect(imgs[0].alt).toBe("有名字");
  });

  it("无图片文档 → 空数组", () => {
    expect(collectDocImages(markdownToDoc("纯文本\n"))).toEqual([]);
  });

  it("表格单元格内的图片也被收集", () => {
    const doc = markdownToDoc("| h |\n| --- |\n| ![t](./assets/t.png) |\n");
    const imgs = collectDocImages(doc);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].src).toBe("./assets/t.png");
  });

  it("data URL 图片同样被收集", () => {
    const doc = markdownToDoc("![图](data:image/png;base64,AAAA)\n");
    const imgs = collectDocImages(doc);
    expect(imgs[0].src).toBe("data:image/png;base64,AAAA");
  });
});

describe("v0.13.0 需求11 isExternalImageSrc / imageFileNameOf", () => {
  it("外部图源判定", () => {
    expect(isExternalImageSrc("data:image/png;base64,AAA")).toBe(true);
    expect(isExternalImageSrc("https://a.com/x.png")).toBe(true);
    expect(isExternalImageSrc("http://a.com/x.png")).toBe(true);
    expect(isExternalImageSrc("D:/pic/x.png")).toBe(true);
    expect(isExternalImageSrc("./assets/x.png")).toBe(false);
    expect(isExternalImageSrc("../x.png")).toBe(false);
    expect(isExternalImageSrc("x.png")).toBe(false);
    expect(isExternalImageSrc("")).toBe(false);
  });

  it("取文件名：相对/绝对/URL/query/目录形态", () => {
    expect(imageFileNameOf("./assets/a.png")).toBe("a.png");
    expect(imageFileNameOf("assets/sub/b.jpg")).toBe("b.jpg");
    expect(imageFileNameOf("D:\\pic\\c.gif")).toBe("c.gif");
    expect(imageFileNameOf("https://a.com/d.png?x=1#y")).toBe("d.png");
    // 以斜杠结尾 = 目录，没有文件名
    expect(imageFileNameOf("./assets/")).toBe("");
    expect(imageFileNameOf("")).toBe("");
  });
});

describe("v0.13.0 需求11 resolveUniqueFileName", () => {
  it("无冲突原名返回", () => {
    expect(resolveUniqueFileName(["b.png"], "a.png")).toBe("a.png");
  });
  it("冲突追加序号（与 ImagePasteDialog 规则一致）", () => {
    expect(resolveUniqueFileName(["a.png"], "a.png")).toBe("a-1.png");
    expect(resolveUniqueFileName(["a.png", "a-1.png"], "a.png")).toBe("a-2.png");
  });
  it("无扩展名同样消解", () => {
    expect(resolveUniqueFileName(["img"], "img")).toBe("img-1");
  });
});

describe("v0.13.0 需求11 planAssetsMigration", () => {
  it("相对路径图 → 新引用 assets/<name>，无需复制", () => {
    const plan = planAssetsMigration({ src: "./pic/a.png" }, []);
    expect(plan).toEqual({ newSrc: "assets/a.png", fileName: "a.png", needsCopy: false });
  });
  it("外部图 → needsCopy=true", () => {
    const plan = planAssetsMigration({ src: "D:/pic/a.png" }, []);
    expect(plan?.needsCopy).toBe(true);
    expect(plan?.newSrc).toBe("assets/a.png");
  });
  it("data URL 无文件名（不得把 base64 载荷当文件名）", () => {
    expect(imageFileNameOf("data:image/png;base64,iVBORw0KGgo=")).toBe("");
    // 迁移计划随之为 null（调用方据此提示失败而不是生成垃圾路径）
    expect(planAssetsMigration({ src: "data:image/png;base64,iVBORw0KGgo=" }, [])).toBeNull();
  });
  it("目标已存在 → 追加序号", () => {
    const plan = planAssetsMigration({ src: "./pic/a.png" }, ["a.png", "a-1.png"]);
    expect(plan?.fileName).toBe("a-2.png");
    expect(plan?.newSrc).toBe("assets/a-2.png");
  });
});

describe("v0.13.0 需求11 findUnreferenced", () => {
  const docImages = collectDocImages(
    markdownToDoc("![a](./assets/a.png)\n\n![b](./assets/b.png)\n"),
  );

  it("assets 中未被本文档引用的文件被列出", () => {
    expect(findUnreferenced(["a.png", "b.png", "c.png", "d.png"], docImages)).toEqual([
      "c.png",
      "d.png",
    ]);
  });

  it("全部被引用 → 空列表", () => {
    expect(findUnreferenced(["a.png", "b.png"], docImages)).toEqual([]);
  });

  it("按文件名（而非路径）比对：./assets/a.png 与 a.png 视为同一张", () => {
    const imgs = collectDocImages(markdownToDoc("![a](./assets/a.png)\n"));
    expect(findUnreferenced(["a.png"], imgs)).toEqual([]);
    expect(findUnreferenced(["a.png", "x.png"], imgs)).toEqual(["x.png"]);
  });

  it("空 assets → 空列表（空态不崩）", () => {
    expect(findUnreferenced([], docImages)).toEqual([]);
  });

  it("保持磁盘顺序（面板展示与用户看到的目录一致）", () => {
    expect(findUnreferenced(["z.png", "y.png", "a.png"], docImages)).toEqual([
      "z.png",
      "y.png",
    ]);
  });
});

describe("v0.13.0 需求11 planRename", () => {
  it("保留原目录前缀", () => {
    expect(planRename("./assets/a.png", "new.png")).toEqual({
      oldSrc: "./assets/a.png",
      newSrc: "./assets/new.png",
      fileName: "new.png",
    });
  });
  it("裸文件名同样可用", () => {
    expect(planRename("a.png", "b.png")?.newSrc).toBe("b.png");
  });
  it("空新名 → null（调用方据此禁用按钮）", () => {
    expect(planRename("./a.png", "  ")).toBeNull();
  });
  it("新名带首尾空格被 trim", () => {
    expect(planRename("./a.png", "  b.png  ")?.newSrc).toBe("./b.png");
  });
  it("原引用无文件名（目录形态）→ null", () => {
    expect(planRename("./assets/", "b.png")).toBeNull();
  });
});

describe("v0.13.0 需求11 countRefsOf", () => {
  it("命中 src 返回引用数", () => {
    const imgs = collectDocImages(
      markdownToDoc("![a](./assets/a.png)\n\n![b](./assets/a.png)\n"),
    );
    expect(countRefsOf(imgs, "./assets/a.png")).toBe(2);
  });
  it("未命中返回 0", () => {
    const imgs = collectDocImages(markdownToDoc("![a](./assets/a.png)\n"));
    expect(countRefsOf(imgs, "./assets/zzz.png")).toBe(0);
  });
});

// ═════════ v0.13.1 需求9：资源管理器定位目标解析 ═════════
// 本组断言随 v0.13.1 返修新增到此文件：revealTargetOf 与既有
// resolveImageAbsPath/imageSourceKind 同属"引用 → 磁盘路径"的真值表，
// 放在一起便于对照两者边界（远程/内联都必须为 null）。

describe("v0.13.1 需求9 revealTargetOf（「本地文件」徽标定位目标）", () => {
  const DOC_DIR = "D:/docs";

  it("相对路径 → 基于文档目录拼出绝对路径", () => {
    expect(revealTargetOf("./assets/a.png", DOC_DIR)).toBe("D:/docs/assets/a.png");
    expect(revealTargetOf("assets/a.png", DOC_DIR)).toBe("D:/docs/assets/a.png");
  });

  it("相对路径的 `..` / `.` 被正确消解（不产出字面量 ..）", () => {
    expect(revealTargetOf("../pic/a.png", "D:/docs/sub")).toBe("D:/docs/pic/a.png");
    expect(revealTargetOf("././assets/a.png", DOC_DIR)).toBe("D:/docs/assets/a.png");
  });

  it("解码后的 asset.localhost URL → 本地绝对路径（本地文件，不是远程）", () => {
    const src =
      "http://asset.localhost/D%3A%2F10254%2F%E6%A1%8C%E9%9D%A2%2Fassets%2Fimage-3.png";
    expect(revealTargetOf(src, DOC_DIR)).toBe("D:/10254/桌面/assets/image-3.png");
  });

  it("Windows / POSIX 绝对路径原样可用（不依赖 docDir）", () => {
    expect(revealTargetOf("D:/pic/a.png", null)).toBe("D:/pic/a.png");
    expect(revealTargetOf("D:\\pic\\a.png", null)).toBe("D:/pic/a.png");
    expect(revealTargetOf("/tmp/a.png", null)).toBe("/tmp/a.png");
  });

  it("query / hash 被剥掉（reveal_in_folder 要的是纯路径）", () => {
    expect(revealTargetOf("./assets/a.png?v=1#x", DOC_DIR)).toBe("D:/docs/assets/a.png");
  });

  it("远程图（http(s) / blob / tauri）→ null（没有本地文件可定位）", () => {
    expect(revealTargetOf("https://a.com/x.png", DOC_DIR)).toBeNull();
    expect(revealTargetOf("http://a.com/x.png", DOC_DIR)).toBeNull();
    expect(revealTargetOf("blob:http://localhost/abc", DOC_DIR)).toBeNull();
    expect(revealTargetOf("tauri://localhost/a.png", DOC_DIR)).toBeNull();
    // asset.localhost 之外的 asset: 主机同样不是本地文件
    expect(revealTargetOf("asset://other/x.png", DOC_DIR)).toBeNull();
  });

  it("data URL → null（内联图没有磁盘落点，不能拿 base64 载荷当路径）", () => {
    expect(revealTargetOf("data:image/png;base64,iVBORw0KGgo=", DOC_DIR)).toBeNull();
    expect(revealTargetOf("data:image/svg+xml,%3Csvg/%3E", DOC_DIR)).toBeNull();
  });

  it("文档未保存（docDir === null）→ 相对引用不可定位，绝对引用仍可", () => {
    expect(revealTargetOf("./assets/a.png", null)).toBeNull();
    expect(revealTargetOf("D:/pic/a.png", null)).toBe("D:/pic/a.png");
  });

  it("空 src → null（面板不会拿空串去 explorer /select,）", () => {
    expect(revealTargetOf("", DOC_DIR)).toBeNull();
  });
});
