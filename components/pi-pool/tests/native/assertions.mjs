import assert from 'node:assert/strict';

export function checkResult(result, mode) {
  const name = result.name.replace(/-claude$/, '');
  const requests = result.requests.filter(request => request.phase === 'test');
  const endings = result.events.filter(event => event.type === 'compaction_end');
  const compacted = endings.some(event => event.result);
  const final = result.messages.at(-1);
  const toolExecutions = result.events.filter(event => event.type === 'tool_execution_end');
  const continued = final?.stopReason === 'stop' && final.text === 'SYNTHETIC_RECOVERY_OK';
  assert.equal(result.notes.fixtureError, undefined);
  assert.equal(result.notes.splitBarrierError, undefined);
  assert.equal(result.notes.exit.code, 0);
  assert.equal(result.notes.finalState.data.isStreaming, false);
  assert.equal(result.notes.finalState.data.isCompacting, false);
  if (name.startsWith('tool-') || name.startsWith('threshold-')) {
    assert.equal(toolExecutions.length, 1, 'execute the native fixture tool once');
    assert.equal(toolExecutions[0].isError, false);
  }
  if (name === 'prompt-auth-cancel') {
    assert.equal(requests.length, 1, 'cancellation prevents the next provider request');
    assert.equal(result.hook.length, 1);
    assert(result.events.some(event => event.type === 'auto_retry_end' && event.finalError === 'Retry cancelled'));
    return;
  }
  if (name.endsWith('hook-exhaust') && name !== 'prompt-hook-exhaust') {
    assert.equal(compacted, false, 'failed credential acquisition cannot commit compaction');
    assert.equal(continued, false, 'failed compaction cannot resume uncompressed work');
    assert.equal(requests.filter(request => request.isSummary).length, 0);
    assert.equal(result.hook.filter(call => call.failed).length, 4, 'one compaction retry budget');
    return;
  }
  if (name === 'prompt-hook-exhaust') {
    assert.equal(requests.length, 0);
    assert.equal(final.stopReason, 'error');
    for (const message of result.messages) {
      assert(message.diagnostics.some(diagnostic => diagnostic.type === 'request_auth_failure'));
      assert(!message.diagnostics.some(diagnostic => ['provider_stream_failure', 'agent_lifecycle_failure'].includes(diagnostic.type)));
      assert.equal(message.usage.totalTokens, 0, 'credential acquisition performs no provider work');
      assert.equal(message.usage.cost.total, 0);
    }
    const expected = process.env.PI_POOL_TEST_RETRY_ENABLED === 'false' ? 1 : 1 + Number(process.env.PI_POOL_TEST_MAX_RETRIES ?? 3);
    assert.equal(result.hook.length, expected, 'one native retry budget bounds hook attempts');
    return;
  }
  if (mode === 'recovery') {
    for (const request of requests) assert.equal(request.headerLabel, request.keyLabel, 'headers belong to the current credential attempt');
    const summaries = requests.filter(request => request.isSummary);
    const slices = Map.groupBy(summaries, request => request.requestId);
    if (/^(compact|threshold|overflow)-/.test(name)) {
      assert.equal(slices.size, name === 'threshold-split-auth-recover' ? 2 : 1, 'native slice count is stable across retries');
      if (name.includes('auth-recover') || name.endsWith('-transient')) assert(summaries.length >= 2, 'the same slice retries');
    }
    for (const [requestId, attempts] of slices) {
      assert(requestId, 'a summary slice has a native semantic request ID');
      assert(attempts.every(attempt => attempt.idempotencyKey === requestId));
      assert.equal(new Set(attempts.map(attempt => attempt.bodyHash)).size, 1, 'retry preserves the summary body');
    }

    if (name === 'threshold-split-auth-recover') {
      assert.deepEqual([...new Set(summaries.map(request => request.slice))].sort(), ['history', 'prefix']);
      for (const attempts of slices.values()) {
        assert.equal(attempts.length, 2, 'each concurrent slice has exactly two attempts');
        assert.equal(new Set(attempts.map(attempt => attempt.slice)).size, 1, 'an ID belongs to one slice');
        assert.deepEqual(attempts.map(attempt => [attempt.keyLabel, attempt.headerLabel, attempt.status]), [['old', 'old', 401], ['new', 'new', 200]]);
      }
      assert.equal(new Set(summaries.map(request => request.bodyHash)).size, 2, 'history and prefix have different bodies');
      assert.equal(endings.filter(event => event.result).length, 1);
      assert.equal(result.notes.persistence.compactions.length, 1);
      const kept = result.notes.persistence.firstKeptEntry.message;
      assert.equal(kept.role, 'assistant');
      assert(kept.content.some(block => block.type === 'toolCall'));
      const liveMessages = result.notes.finalMessages.data.messages;
      const liveCalls = liveMessages.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(block => block.type === 'toolCall'));
      const liveResults = liveMessages.filter(message => message.role === 'toolResult');
      assert.equal(liveCalls.length, 1, 'compaction retains the tool call in live context');
      assert.equal(liveResults.length, 1, 'compaction retains the result in live context');
      assert.equal(liveCalls[0].id, liveResults[0].toolCallId);
      const continuation = requests.filter(request => !request.isSummary).at(-1);
      assert.equal(continuation.wireToolCallIds.length, 1);
      assert.deepEqual(continuation.wireToolCallIds, continuation.wireToolResultIds);
      assert.equal(continuation.hasToolResultText, true);
    }
    if (name.startsWith('compact-')) assert.equal(result.notes.compact.success, true, 'manual compaction succeeds without another command');
    else assert(continued, 'the original accepted work reaches the final answer');
    if (/^(compact|threshold|overflow)-/.test(name)) assert(compacted, 'compaction succeeds, not merely a failed-compaction continuation');
    if (name.includes('auth-recover')) assert(requests.some(request => request.keyLabel === 'new' && request.status === 200), 'retry obtains usable credentials');
    return;
  }
  if (['prompt-hook-recover', 'iteration-hook-recover', 'tool-hook-recover'].includes(name)) {
    assert.equal(final.stopReason, 'error');
    assert(final.diagnostics.some(diagnostic => diagnostic.type === 'agent_lifecycle_failure'));
    assert.equal(result.events.filter(event => event.type === 'auto_retry_start').length, 0);
    assert.equal(requests.length, name === 'prompt-hook-recover' ? 0 : 1);
  } else if (name === 'prompt-auth-recover') {
    assert(continued);
    assert.deepEqual(requests.map(request => [request.keyLabel, request.status]), [['old', 401], ['new', 200]]);
  } else if (name.endsWith('-transient')) {
    assert(compacted);
    if (!name.startsWith('compact-')) assert(continued);
  } else {
    assert.equal(compacted, false);
    assert(endings.some(event => event.errorMessage));
    if (name.startsWith('compact-')) assert.equal(result.notes.compact.success, false);
    else assert.equal(continued, name.startsWith('threshold-'));
    if (name.includes('auth-recover')) {
      const summaries = requests.filter(request => request.isSummary);
      assert.equal(summaries.length, name === 'threshold-split-auth-recover' ? 4 : 2);
      assert(summaries.every(request => request.status === 401 && request.keyLabel === 'old'));
    }
  }
}
