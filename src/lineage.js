/**
 * 分支推断。
 *
 * Claude Code 的会话文件之间没有任何显式的 fork / resume 指针：
 * 续写一个会话会产生一个全新的文件，除了内容相同的开头之外，
 * 和源会话毫无关联字段。所以父子关系只能靠共享的用户输入前缀来还原，
 * 共享前缀的长度就相当于 DSH 里那个 seedLength——分叉发生的位置。
 */

/** 两个签名从头开始相同的长度。 */
export function sharedPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) index += 1
  return index
}

/**
 * 在一组同工作区的会话里推断父子关系。
 *
 * @param {Array<{id:string, signature:string[], nodes:Array, createdAt:string|null}>} sessions
 * @returns {Map<string, {parentId:string|null, seedSeq:number|null, shared:number, confidence:number}>}
 */
export function inferLineage(sessions) {
  const result = new Map()

  for (const child of sessions) {
    let best = null
    for (const candidate of sessions) {
      if (candidate.id === child.id) continue
      const shared = sharedPrefixLength(candidate.signature, child.signature)
      if (shared === 0) continue
      // 父必须先于子存在。这条判据同时保证了不对称：两个会话互相比较时
      // 只有一个方向成立，否则双方会互指对方为父，形成 2-环。
      if (!precedes(candidate, child)) continue
      if (best === null || betterParent(candidate, shared, best)) best = { candidate, shared }
    }

    result.set(child.id, best === null
      ? { parentId: null, seedSeq: null, shared: 0, confidence: 0 }
      : {
          parentId: best.candidate.id,
          seedSeq: seedSeqOf(best.candidate, best.shared),
          shared: best.shared,
          confidence: best.shared / Math.min(best.candidate.signature.length, child.signature.length),
        })
  }

  return breakCycles(result, sessions)
}

/**
 * candidate 是否早于 child 存在。
 *
 * 不能用 createdAt：续写会把父会话的历史整个复制到新文件里，首条记录的
 * 时间戳是继承来的，同一次分叉出来的几个文件读起来几乎完全相同。
 * 最后活动时间才真正反映谁先收尾，谁还在继续往下走。
 *
 * 时间仍相同时退到长度、再退到 id，保证任意两个会话之间的先后判断
 * 唯一且可复现——这个不对称性正是不出现互指成环的原因。
 */
function precedes(candidate, child) {
  const candidateAt = candidate.updatedAt ?? candidate.createdAt ?? ''
  const childAt = child.updatedAt ?? child.createdAt ?? ''
  if (candidateAt !== childAt) return candidateAt < childAt
  if (candidate.signature.length !== child.signature.length) {
    return candidate.signature.length < child.signature.length
  }
  return candidate.id < child.id
}

/**
 * tie-break 必须完全确定，否则同样的输入每次刷新都会画出不同的树。
 */
function betterParent(candidate, shared, best) {
  if (shared !== best.shared) return shared > best.shared
  // 共享一样多时，更短的会话离分叉点更近，更可能是直接的父。
  if (candidate.signature.length !== best.candidate.signature.length) {
    return candidate.signature.length < best.candidate.signature.length
  }
  const candidateAt = candidate.createdAt ?? ''
  const bestAt = best.candidate.createdAt ?? ''
  if (candidateAt !== bestAt) return candidateAt < bestAt
  return candidate.id < best.candidate.id
}

/**
 * 共享前缀的第 shared 个用户输入，对应父会话里的哪一行。
 * 画布用 `sourceSeq < seedLength` 挑出分叉点之前的最后一张卡片。
 */
function seedSeqOf(parent, shared) {
  const questions = parent.nodes.filter(node => node.kind === 'user' && node.text.trim() !== '')
  if (questions.length === 0) return null
  return shared >= questions.length
    ? questions[questions.length - 1].seq + 1
    : questions[shared].seq
}

/**
 * 断开环。
 *
 * 画布的递归布局和级联删除都假设这是一棵森林；留下环会让布局退化，
 * 删除时还会打转。环里最晚创建的那条边最可能是误判，优先断它。
 */
function breakCycles(result, sessions) {
  const createdAt = new Map(sessions.map(session => [session.id, session.createdAt ?? '']))

  for (const start of result.keys()) {
    const seen = new Set([start])
    let current = start
    while (true) {
      const parentId = result.get(current)?.parentId
      if (parentId === null || parentId === undefined || !result.has(parentId)) break
      if (!seen.has(parentId)) {
        seen.add(parentId)
        current = parentId
        continue
      }
      // 回到了走过的节点：沿环找出最晚创建的一条边断开。
      let victim = current
      let cursor = parentId
      while (cursor !== current) {
        if ((createdAt.get(cursor) ?? '') > (createdAt.get(victim) ?? '')) victim = cursor
        cursor = result.get(cursor).parentId
      }
      result.set(victim, { ...result.get(victim), parentId: null, seedSeq: null, shared: 0, confidence: 0 })
      break
    }
  }

  return result
}
