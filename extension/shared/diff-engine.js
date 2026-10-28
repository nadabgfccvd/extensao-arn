(function (global) {
  'use strict';

  function quickTextHash(str) {
    const s = String(str || '');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0') + ':' + s.length;
  }

  function splitLines(text) {
    if (!text) return [];
    return String(text).replace(/\r\n/g, '\n').split('\n');
  }

  // Fast bounded LCS diff with common prefix/suffix trimming
  function computeLineEdits(oldLines, newLines) {
    let start = 0;
    const oldLen = oldLines.length;
    const newLen = newLines.length;
    while (start < oldLen && start < newLen && oldLines[start] === newLines[start]) {
      start++;
    }
    let oldEnd = oldLen - 1;
    let newEnd = newLen - 1;
    while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    const edits = [];
    for (let i = 0; i < start; i++) {
      edits.push({ type: 'equal', line: oldLines[i], oldLineNo: i + 1, newLineNo: i + 1 });
    }

    const midOld = oldLines.slice(start, oldEnd + 1);
    const midNew = newLines.slice(start, newEnd + 1);
    const n = midOld.length;
    const m = midNew.length;

    if (n === 0 && m === 0) {
      // Nothing in middle
    } else if (n * m > 360000) {
      // Very large hunk fallback: emit removals then additions cleanly without O(N*M) stall
      for (let i = 0; i < n; i++) {
        edits.push({ type: 'del', line: midOld[i], oldLineNo: start + i + 1, newLineNo: null });
      }
      for (let j = 0; j < m; j++) {
        edits.push({ type: 'add', line: midNew[j], oldLineNo: null, newLineNo: start + j + 1 });
      }
    } else {
      const cols = m + 1;
      const dp = new Uint16Array((n + 1) * cols);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          if (midOld[i] === midNew[j]) {
            dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
          } else {
            const down = dp[(i + 1) * cols + j];
            const right = dp[i * cols + (j + 1)];
            dp[i * cols + j] = down >= right ? down : right;
          }
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (midOld[i] === midNew[j]) {
          edits.push({
            type: 'equal',
            line: midOld[i],
            oldLineNo: start + i + 1,
            newLineNo: start + j + 1
          });
          i++;
          j++;
        } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
          edits.push({ type: 'del', line: midOld[i], oldLineNo: start + i + 1, newLineNo: null });
          i++;
        } else {
          edits.push({ type: 'add', line: midNew[j], oldLineNo: null, newLineNo: start + j + 1 });
          j++;
        }
      }
      while (i < n) {
        edits.push({ type: 'del', line: midOld[i], oldLineNo: start + i + 1, newLineNo: null });
        i++;
      }
      while (j < m) {
        edits.push({ type: 'add', line: midNew[j], oldLineNo: null, newLineNo: start + j + 1 });
        j++;
      }
    }

    const tailCount = oldLen - 1 - oldEnd;
    for (let k = 0; k < tailCount; k++) {
      edits.push({
        type: 'equal',
        line: oldLines[oldEnd + 1 + k],
        oldLineNo: oldEnd + 2 + k,
        newLineNo: newEnd + 2 + k
      });
    }
    return edits;
  }

  function buildDiffHunks(oldText, newText, contextLines) {
    const ctx = typeof contextLines === 'number' ? contextLines : 3;
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    const edits = computeLineEdits(oldLines, newLines);

    let added = 0;
    let deleted = 0;
    const changedIndices = [];
    for (let i = 0; i < edits.length; i++) {
      if (edits[i].type !== 'equal') {
        changedIndices.push(i);
        if (edits[i].type === 'add') added++;
        if (edits[i].type === 'del') deleted++;
      }
    }
    if (!changedIndices.length) {
      return { hunks: [], added: 0, deleted: 0, identical: true };
    }

    const ranges = [];
    for (let k = 0; k < changedIndices.length; k++) {
      const idx = changedIndices[k];
      const rStart = Math.max(0, idx - ctx);
      const rEnd = Math.min(edits.length - 1, idx + ctx);
      if (ranges.length && rStart <= ranges[ranges.length - 1].end + 1) {
        ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, rEnd);
      } else {
        ranges.push({ start: rStart, end: rEnd });
      }
    }

    const hunks = ranges.map((r) => {
      const slice = edits.slice(r.start, r.end + 1);
      let oldStart = 1;
      let newStart = 1;
      let oldCount = 0;
      let newCount = 0;
      for (let s = 0; s < slice.length; s++) {
        if (slice[s].oldLineNo) {
          oldStart = slice[s].oldLineNo;
          break;
        }
      }
      for (let s = 0; s < slice.length; s++) {
        if (slice[s].newLineNo) {
          newStart = slice[s].newLineNo;
          break;
        }
      }
      for (let s = 0; s < slice.length; s++) {
        if (slice[s].type !== 'add') oldCount++;
        if (slice[s].type !== 'del') newCount++;
      }
      return {
        header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        lines: slice
      };
    });

    return { hunks, added, deleted, identical: false };
  }

  function formatUnifiedDiff(filePath, oldText, newText, oldLabel, newLabel) {
    const cleanPath = String(filePath || 'file').replace(/^\/+/, '');
    const res = buildDiffHunks(oldText, newText, 3);
    if (res.identical) return '';
    const out = [
      `--- ${oldLabel || 'a/' + cleanPath}`,
      `+++ ${newLabel || 'b/' + cleanPath}`
    ];
    for (let i = 0; i < res.hunks.length; i++) {
      const hk = res.hunks[i];
      out.push(hk.header);
      for (let j = 0; j < hk.lines.length; j++) {
        const ln = hk.lines[j];
        const prefix = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';
        out.push(prefix + ln.line);
      }
    }
    return out.join('\n');
  }

  // PROD-01: Multi-Agent Snapshot Diff + File Conflict Matrix
  // agentSnapshots: [{ agentTag, agentLabel, round, ts, files: [{ path, text, hash }] }]
  function computeMultiAgentRoomDiff(agentSnapshots, baselineMap) {
    const snapshots = Array.isArray(agentSnapshots) ? agentSnapshots : [];
    const base = baselineMap && typeof baselineMap === 'object' ? baselineMap : {};
    const byPath = new Map();

    for (let s = 0; s < snapshots.length; s++) {
      const snap = snapshots[s];
      if (!snap || !Array.isArray(snap.files)) continue;
      const tag = String(snap.agentTag || `AGENT_${s + 1}`);
      const label = String(snap.agentLabel || tag);
      for (let f = 0; f < snap.files.length; f++) {
        const file = snap.files[f];
        if (!file || !file.path) continue;
        const p = String(file.path).replace(/^\/+/, '');
        const text = file.text !== undefined ? String(file.text) : '';
        const hash = file.hash || quickTextHash(text);
        const baseEntry = base[p];
        const baseText = baseEntry && baseEntry.text !== undefined ? String(baseEntry.text) : '';
        const baseHash = (baseEntry && baseEntry.hash) || (baseEntry ? quickTextHash(baseText) : '');
        if (baseEntry && hash === baseHash) continue; // Unchanged from baseline

        if (!byPath.has(p)) {
          byPath.set(p, {
            path: p,
            baseText,
            hasBaseline: Boolean(baseEntry),
            variants: []
          });
        }
        const rec = byPath.get(p);
        const existingIdx = rec.variants.findIndex((v) => v.agentTag === tag);
        const vEntry = {
          agentTag: tag,
          agentLabel: label,
          round: Number(snap.round || 1),
          ts: Number(snap.ts || 0),
          hash,
          text
        };
        if (existingIdx >= 0) rec.variants[existingIdx] = vEntry;
        else rec.variants.push(vEntry);
      }
    }

    const conflicts = [];
    const files = [];
    for (const [, entry] of byPath.entries()) {
      const distinctHashes = new Set(entry.variants.map((v) => v.hash));
      const hasConflict = entry.variants.length >= 2 && distinctHashes.size >= 2;
      let unifiedPreview = '';
      let added = 0;
      let deleted = 0;

      if (hasConflict) {
        const vA = entry.variants[0];
        const vB = entry.variants[1];
        const hunks = buildDiffHunks(vA.text, vB.text, 3);
        added = hunks.added;
        deleted = hunks.deleted;
        unifiedPreview = formatUnifiedDiff(
          entry.path,
          vA.text,
          vB.text,
          `${vA.agentTag}/${entry.path}`,
          `${vB.agentTag}/${entry.path}`
        );
        conflicts.push({
          path: entry.path,
          agents: entry.variants.map((v) => v.agentTag),
          agentLabels: entry.variants.map((v) => v.agentLabel),
          added,
          deleted,
          unifiedDiff: unifiedPreview
        });
      } else if (entry.variants.length >= 1) {
        const latest = entry.variants[entry.variants.length - 1];
        const hunks = buildDiffHunks(entry.baseText, latest.text, 3);
        added = hunks.added;
        deleted = hunks.deleted;
        unifiedPreview = formatUnifiedDiff(
          entry.path,
          entry.baseText,
          latest.text,
          entry.hasBaseline ? `base/${entry.path}` : `/dev/null`,
          `${latest.agentTag}/${entry.path}`
        );
      }

      files.push({
        path: entry.path,
        conflict: hasConflict,
        touchedBy: entry.variants.map((v) => ({
          agentTag: v.agentTag,
          agentLabel: v.agentLabel,
          round: v.round,
          hash: v.hash
        })),
        added,
        deleted,
        unifiedDiff: unifiedPreview.slice(0, 24000)
      });
    }

    files.sort((a, b) => (b.conflict ? 1 : 0) - (a.conflict ? 1 : 0) || a.path.localeCompare(b.path));
    return {
      totalFilesChanged: files.length,
      conflictCount: conflicts.length,
      conflicts,
      files
    };
  }

  global.AU_DIFF = {
    quickTextHash,
    computeLineEdits,
    buildDiffHunks,
    formatUnifiedDiff,
    computeMultiAgentRoomDiff
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
