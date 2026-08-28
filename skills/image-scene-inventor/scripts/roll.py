#!/usr/bin/env python3
"""场景骰子。

两种模式：

  brief（默认）—— 回答"到底要做什么事"。先掷一个命题（任务形态 + 母题 + 约束 +
                    交付），再由命题决定出几张、锁哪条路线、哪条轴是变量，
                    最后给出每一张的场景种子。零输入可用。
  scene         —— 已经知道要做什么了，只要随机画面。

模型自己"随机想"会反复落在同几个安全答案上，所以随机必须由这个脚本来做。
"""

import argparse
import json
import random
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# 任务形态里写的是抽象轴名，各路线的轴叫法不同，按偏好顺序映射过去。
AXIS_ALIASES = {
    "镜头杠杆": ["镜头杠杆", "构图杠杆"],
    "时间光线": ["时间光线", "时间天气", "光线天气", "天气光线", "光源"],
    "情境": [
        "情境",
        "出现方式",
        "主体动作",
        "场景",
        "真实地点锚点",
        "目的地",
        "世界主题",
    ],
}


def resolve_axis(name, route, n, rng):
    """把任务形态要求的轴解析成这条路线真实存在的轴名。"""
    axes = route["axes"]
    if name in ("无", "叙事时刻") or name in axes:
        return name
    for candidate in AXIS_ALIASES.get(name, []):
        if candidate in axes:
            return candidate
    # 兜底：优先选够 n 个选项的轴，选不到就选最大的那条
    roomy = [a for a, v in axes.items() if len(v) >= n]
    return rng.choice(roomy) if roomy else max(axes, key=lambda a: len(axes[a]))


def load(name):
    with (ASSETS / name).open(encoding="utf-8") as f:
        return json.load(f)


def pick_distinct(rng, pool, k):
    """从 pool 里取 k 个不重复值；池子不够时允许回环。"""
    pool = list(pool)
    if k <= len(pool):
        return rng.sample(pool, k)
    out = []
    while len(out) < k:
        batch = rng.sample(pool, len(pool))
        out.extend(batch[: k - len(out)])
    return out


def resolve_medium(route, uni, wanted, rng, wild=False):
    """决定这次用什么媒介。用户指定 > 随机(wild) > 路线默认。"""
    avail = route.get("可用媒介") or [route.get("默认媒介", "实拍摄影")]
    if wanted:
        hit = [m for m in avail if wanted in m]
        if hit:
            return hit[0]
        # 用户点名了这条路线不支持的媒介，照给，但标出来
        allm = [m["名称"] for m in uni.get("媒介", [])]
        hit = [m for m in allm if wanted in m]
        if hit:
            return hit[0] + "（本路线非常规媒介，按用户指定）"
        return wanted
    if wild and len(avail) > 1:
        return rng.choice(avail)
    return route.get("默认媒介", avail[0])


def medium_line(name, uni):
    base = name.split("（")[0]
    for m in uni.get("媒介", []):
        if m["名称"] == base:
            return [f"媒介: {name}", f"  渲染: {m['渲染']}", f"  忌: {m['忌']}"]
    return [f"媒介: {name}"]


def route_header(key, route):
    return [
        f"路线: {route['name']}  [{key}]",
        f"仓库模板: {', '.join(route['sources'])}",
        f"catalog 路线名: {route['catalog_route']}",
    ]


def base_seed(rng, route):
    """给一条路线的每个轴各抽一个值。"""
    return {axis: rng.choice(pool) for axis, pool in route["axes"].items()}


def hybrid_line(rng, routes, uni, exclude):
    others = [k for k in routes if k != exclude]
    bk = rng.choice(others)
    b = routes[bk]
    element = rng.choice(uni["借用元素"])
    b_axis, b_pool = rng.choice(list(b["axes"].items()))
    return [
        f"跨路线杂交: 借用「{b['name']}」的{element}，其余保持本路线",
        f"杂交参考值: {b_axis} = {rng.choice(b_pool)}",
    ]


# ---------------------------------------------------------------- scene mode


def cmd_scene(data, args):
    routes = data["routes"]
    uni = data["universal"]
    rng = random.Random(args.seed)
    keys = list(routes)
    picked = []

    for i in range(args.count):
        if args.route:
            key = args.route
        else:
            pool = [k for k in keys if k not in picked] or keys
            key = rng.choice(pool)
            picked.append(key)
        route = routes[key]

        lines = route_header(key, route)
        lines += medium_line(
            resolve_medium(route, uni, args.medium, rng, args.wild), uni
        )
        for axis, value in base_seed(rng, route).items():
            lines.append(f"{axis}: {value}")
        lines.append(f"叙事时刻: {rng.choice(uni['叙事时刻'])}")
        lines.append(f"反差注入: {rng.choice(uni['反差注入'])}")
        if args.wild:
            lines += hybrid_line(rng, routes, uni, key)

        print(f"===== 场景种子 {i + 1} =====")
        print("\n".join(lines))
        print()


# ---------------------------------------------------------------- brief mode


def cmd_brief(data, briefs, args):
    routes = data["routes"]
    uni = data["universal"]
    rng = random.Random(args.seed)

    forms = briefs["任务形态"]
    if args.form is not None:
        if not 1 <= args.form <= len(forms):
            print(f"任务形态编号超出范围 1–{len(forms)}", file=sys.stderr)
            sys.exit(1)
        form = forms[args.form - 1]
    else:
        form = rng.choice(forms)

    n = args.count if args.count else form["张数"]
    mode = form["路线模式"]
    wild = args.wild or form.get("强制杂交", False)

    print("===== 命题 =====")
    print(f"做什么事: {form['名称']}（{n} 张）")
    print(f"说明: {form['说明']}")
    print(f"母题: {rng.choice(briefs['母题'])}")
    print(f"约束: {rng.choice(briefs['约束'])}")
    if form.get("附加池"):
        print(f"练习项: {rng.choice(briefs[form['附加池']])}")
    print(f"交付: {rng.choice(briefs['交付'])}")
    print()

    if mode == "varied":
        keys = pick_distinct(rng, list(routes), n)
        print("路线: 每张换一条路线，只有母题是共同的")
        print()
        for i, key in enumerate(keys, 1):
            route = routes[key]
            print(f"--- 第 {i} 张 ---")
            print("\n".join(route_header(key, route)))
            print("\n".join(medium_line(
                resolve_medium(route, uni, args.medium, rng, wild), uni)))
            for axis, value in base_seed(rng, route).items():
                print(f"{axis}: {value}")
            print(f"叙事时刻: {rng.choice(uni['叙事时刻'])}")
            print(f"反差注入: {rng.choice(uni['反差注入'])}")
            print()
        return

    key = args.route or rng.choice(list(routes))
    route = routes[key]
    print("\n".join(route_header(key, route)))
    print("\n".join(medium_line(
        resolve_medium(route, uni, args.medium, rng, wild), uni)))

    if mode == "hybrid":
        print("路线: 两张同题材，第二张被另一条路线的语法改写")
        base = base_seed(rng, route)
        shared = [f"{a}: {v}" for a, v in base.items()]
        shared.append(f"叙事时刻: {rng.choice(uni['叙事时刻'])}")
        print()
        print("--- 共享题材（两张都不变） ---")
        print("\n".join(shared))
        print()
        print("--- 第 1 张 · 纯本路线 ---")
        print("按本路线默认语法拍，不做任何借用")
        print()
        print("--- 第 2 张 · 被改写 ---")
        print("\n".join(hybrid_line(rng, routes, uni, key)))
        print(f"反差注入: {rng.choice(uni['反差注入'])}")
        print()
        return

    # locked
    axis_name = form["变化轴"]
    if axis_name == "随机":
        axis_name = resolve_axis("__random__", route, n, rng)
    else:
        axis_name = resolve_axis(axis_name, route, n, rng)

    base = base_seed(rng, route)
    narrative = rng.choice(uni["叙事时刻"])

    print(f"路线锁定: {n} 张全部用这一条路线")
    print(f"变化轴: {axis_name}")
    print()
    print("--- 共享设定（所有张都不变） ---")
    for axis, value in base.items():
        if axis != axis_name:
            print(f"{axis}: {value}")
    if axis_name != "叙事时刻":
        print(f"叙事时刻: {narrative}")
    print(f"反差注入: {rng.choice(uni['反差注入'])}")
    if wild:
        print("\n".join(hybrid_line(rng, routes, uni, key)))
    print()

    if axis_name == "无":
        return

    pool = uni["叙事时刻"] if axis_name == "叙事时刻" else route["axes"][axis_name]
    values = pick_distinct(rng, pool, n)

    # 主轴选项不够 n 个时，补一条副轴，保证每张组合仍然唯一
    sec_name = sec_values = None
    if len(pool) < n:
        others = [a for a in route["axes"] if a != axis_name]
        if others:
            sec_name = max(others, key=lambda a: len(route["axes"][a]))
            sec_values = pick_distinct(rng, route["axes"][sec_name], n)
            print(
                f"（{axis_name} 只有 {len(pool)} 个选项，不够 {n} 张，"
                f"并入副轴 {sec_name} 一起变化）"
            )
            print()

    for i, value in enumerate(values, 1):
        print(f"--- 第 {i} 张 ---")
        print(f"{axis_name}: {value}")
        if sec_values:
            print(f"{sec_name}: {sec_values[i - 1]}")
    print()


# ---------------------------------------------------------------- cli


def main():
    p = argparse.ArgumentParser(
        description="图片场景骰子：不知道做什么就直接跑，无参数即可。"
    )
    sub = p.add_subparsers(dest="mode")

    b = sub.add_parser("brief", help="掷命题（默认）：做什么事 + 每张的场景种子")
    b.add_argument("-r", "--route", help="固定路线 key")
    b.add_argument("-n", "--count", type=int, help="覆盖任务形态自带的张数")
    b.add_argument("-f", "--form", type=int, help="指定任务形态编号，见 --forms")
    b.add_argument("-m", "--medium", help="指定媒介，如 动画 / 水彩 / 胶片 / 厚涂 / 海报 / 实拍")
    b.add_argument("--wild", action="store_true", help="强制跨路线杂交 + 随机媒介")
    b.add_argument("--seed", type=int, help="固定随机种子，便于复现")

    s = sub.add_parser("scene", help="只要随机画面，不要命题")
    s.add_argument("-n", "--count", type=int, default=3)
    s.add_argument("-r", "--route", help="固定路线 key")
    s.add_argument("-m", "--medium", help="指定媒介")
    s.add_argument("--wild", action="store_true")
    s.add_argument("--seed", type=int)

    p.add_argument("--list", action="store_true", help="列出全部路线 key")
    p.add_argument("--forms", action="store_true", help="列出全部任务形态")
    p.add_argument("--media", action="store_true", help="列出全部媒介")
    for flag, kw in (
        ("-r", {"dest": "route"}),
        ("-n", {"dest": "count", "type": int}),
        ("-f", {"dest": "form", "type": int}),
        ("-m", {"dest": "medium"}),
    ):
        p.add_argument(flag, **kw)
    p.add_argument("--wild", action="store_true")
    p.add_argument("--seed", type=int)

    args = p.parse_args()
    data = load("axes.json")
    briefs = load("briefs.json")

    if args.list:
        for k, v in data["routes"].items():
            print(f"{k:24s} {v['name']}  <- {v['sources'][0]}")
        return
    if args.media:
        for m in data["universal"]["媒介"]:
            print(f"{m['名称']}\n  渲染: {m['渲染']}\n  忌: {m['忌']}")
        return
    if args.forms:
        for i, f in enumerate(briefs["任务形态"], 1):
            print(f"{i:2d}. {f['名称']}  ({f['张数']} 张 / {f['路线模式']})")
        return

    if args.route and args.route not in data["routes"]:
        print(
            f"未知路线: {args.route}\n可用: {', '.join(data['routes'])}",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.mode == "scene":
        cmd_scene(data, args)
    else:
        cmd_brief(data, briefs, args)


if __name__ == "__main__":
    main()
