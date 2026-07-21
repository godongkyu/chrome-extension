const ATTRS = ['href', 'data-omni-type', 'data-omni', 'title', 'alt'];

// onclick 안에 이 함수들이 호출되어 있으면, 그 첫 번째 인자(파라미터)도
// 속성 검사 탭에서 하나의 "속성"처럼 취급해서 값이 비어있는지 같이 검사한다.
// 예: onclick="specialCounselAplPop(10);" -> 파라미터 "10"
const ONCLICK_FNS = ['specialCounselAplPop'];

// 특정 태그는 "값이 비어있는지"뿐 아니라 "속성 자체가 존재하는지"까지 검사한다.
// 목록에 없는 태그는 기존처럼 ATTRS 중 실제로 존재하는 속성만 검사한다.
const REQUIRED_ATTRS_BY_TAG = {
  a: ['href', 'class', 'data-omni-type', 'data-omni', 'title'],
  button: ['class', 'data-omni-type', 'data-omni', 'title'],
  img: ['loading', 'alt']
};

// 속성 검사 탭은 이 셀렉터에 해당하는 영역 안의 요소만 스캔한다 (null/빈 값이면 전체 스캔)
const SCAN_SCOPE_SELECTOR = '.sec_project_wrap';

// 페이지(inspected window) 안에서 실행되는 스캔 스크립트들이 공통으로 쓰는 헬퍼 함수들.
// chrome.devtools.inspectedWindow.eval()은 매번 완전히 독립된 문자열을 실행하므로
// import를 쓸 수 없어, 각 build*ScanScript 템플릿에 그대로 삽입해서 공유한다.
const INJECTED_HELPERS = `
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += '#' + CSS.escape(el.id);
        path.unshift(selector);
        break;
      }
      let sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName.toLowerCase() === el.nodeName.toLowerCase()) nth++;
      }
      selector += ':nth-of-type(' + nth + ')';
      path.unshift(selector);
      el = el.parentElement;
    }
    return path.join(' > ');
  }
  function findGroup(el) {
    let cur = el.parentElement;
    while (cur && cur.tagName !== 'BODY') {
      if (cur.id) return '#' + cur.id;
      cur = cur.parentElement;
    }
    return '(영역 구분 없음)';
  }
  function isEmptyVal(v) {
    if (v === null || v === undefined) return true;
    return String(v).trim() === '';
  }
  // chrome.devtools.inspectedWindow.eval()은 Promise를 기다려주지 않고 평가 결과를
  // 그대로 반환하므로(비동기 불가), <script src>로 분리된 외부 js 파일 내용은
  // 동기(synchronous) XHR로 읽어온다. file://에서 다른 파일로의 요청이나 교차 출처
  // 요청은 보안 정책상 막히니, 실패하면 조용히 빈 문자열을 반환한다.
  function fetchScriptTextSync(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) return xhr.responseText;
    } catch (e) {
      // file:// 차단, CORS, 네트워크 오류 등 - 조용히 무시
    }
    return '';
  }
`;

function buildDomScanScript(attrs, onclickFns, requiredAttrsByTag, scanScopeSelector) {
  return `(function () {
    ${INJECTED_HELPERS}
    const attrs = ${JSON.stringify(attrs)};
    const onclickFns = ${JSON.stringify(onclickFns)};
    const requiredAttrsByTag = ${JSON.stringify(requiredAttrsByTag)};
    const scanScopeSelector = ${JSON.stringify(scanScopeSelector)};
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      return true;
    }
    function isInScope(el) {
      if (!scanScopeSelector) return true;
      let cur = el;
      while (cur) {
        if (cur.matches && cur.matches(scanScopeSelector)) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    function extractOnclickParam(el, fnName) {
      const onclickText = el.getAttribute('onclick');
      if (!onclickText) return null;
      const marker = fnName + '(';
      const idx = onclickText.indexOf(marker);
      if (idx === -1) return null;
      const argStart = idx + marker.length;
      let end = argStart;
      while (end < onclickText.length && onclickText[end] !== ',' && onclickText[end] !== ')') end++;
      let rawArg = onclickText.slice(argStart, end).trim();
      if (
        (rawArg.charAt(0) === '"' && rawArg.charAt(rawArg.length - 1) === '"') ||
        (rawArg.charAt(0) === "'" && rawArg.charAt(rawArg.length - 1) === "'")
      ) {
        rawArg = rawArg.slice(1, -1);
      }
      return rawArg;
    }
    const results = [];
    document.querySelectorAll('*').forEach(function (el) {
      if (!isVisible(el)) return;
      if (!isInScope(el)) return;
      const matched = [];
      const required = requiredAttrsByTag[el.tagName.toLowerCase()];
      if (required) {
        // 이 태그는 필수 속성 목록이 정해져 있음 -> 속성이 아예 없는 경우까지 검사
        required.forEach(function (attr) {
          const exists = el.hasAttribute(attr);
          const value = exists ? el.getAttribute(attr) : null;
          matched.push({
            attr: attr,
            value: value,
            empty: exists ? isEmptyVal(value) : true,
            missing: !exists
          });
        });
      } else {
        attrs.forEach(function (attr) {
          if (el.hasAttribute(attr)) {
            const value = el.getAttribute(attr);
            matched.push({
              attr: attr,
              value: value,
              empty: isEmptyVal(value)
            });
          }
        });
      }
      onclickFns.forEach(function (fnName) {
        const param = extractOnclickParam(el, fnName);
        if (param !== null) {
          matched.push({
            attr: fnName + '() 파라미터',
            value: param,
            empty: isEmptyVal(param)
          });
        }
      });
      if (matched.length > 0) {
        results.push({
          kind: 'dom',
          label: el.tagName.toLowerCase(),
          path: cssPath(el),
          group: findGroup(el),
          attrs: matched
        });
      }
    });
    return results;
  })()`;
}

function buildRubiconScanScript() {
  return `(function () {
    ${INJECTED_HELPERS}
    function validateValue(key, val) {
      const issues = [];
      if (val === null || val === undefined) return issues;
      const str = String(val);
      if (str.trim() === '') return issues;

      if (str !== str.trim()) issues.push('앞뒤 공백');
      if (/ {2,}/.test(str)) issues.push('연속 공백');
      if (/([!?.,])\\1{1,}/.test(str)) issues.push('반복된 특수문자');
      if (/<[a-z][^>]*>/i.test(str)) issues.push('HTML 태그 잔존');

      [['(', ')'], ['[', ']'], ['{', '}']].forEach(function (p) {
        const openCount = str.split(p[0]).length - 1;
        const closeCount = str.split(p[1]).length - 1;
        if (openCount !== closeCount) issues.push('괄호 짝 안맞음(' + p[0] + p[1] + ')');
      });

      const trimmedStr = str.trim();
      const looksLikeUrl = /url/i.test(key)
        || trimmedStr.indexOf('//') === 0
        || trimmedStr.indexOf('http://') === 0
        || trimmedStr.indexOf('https://') === 0;
      if (looksLikeUrl) {
        let testUrl = trimmedStr;
        if (testUrl.indexOf('//') === 0) testUrl = 'https:' + testUrl;
        try {
          new URL(testUrl);
        } catch (e) {
          issues.push('URL 형식 아님');
        }
      }

      return issues;
    }
    function diagnoseStructure(text) {
      const issues = [];
      const insertions = []; // { index, char } - 복구 시 이 위치에 이 문자열을 끼워 넣어야 함
      const stack = []; // { char: '{'|'[', index }
      let inString = false;
      let escape = false;
      let lineStartInString = false;
      // 문자열이 줄 중간에서 열렸는데 그 줄 끝까지 안 닫힌 경우, 그 지점을 후보로 기억.
      // 그 다음 줄에서 정상적으로 닫히면 후보를 해제한다.
      // (전체 텍스트 끝에서 봤을 때 '어디서부터' 안 닫힌 상태가 이어져왔는지 정확히 짚기 위함 -
      //  뒤쪽 줄의 따옴표를 엉뚱하게 자기 닫는 따옴표로 착각해서 실제 위치보다 훨씬 뒤를
      //  가리키는 문제를 방지한다)
      let unresolvedQuoteLineEnd = -1;
      // "{"/"[" 바로 앞의 마지막 유효 문자를 기억해뒀다가, 배열 대괄호가 통째로 빠진
      // 경우("key": {...} 다음에 콤마 찍고 새 키 없이 또 { 가 오는 패턴)를 감지하는 데 쓴다.
      let lastNonSpaceChar = '';

      function handleLineEnd(endIndex) {
        // CRLF 줄바꿈이면 \\r 는 줄 내용에 포함시키지 않고 그 앞을 줄 끝으로 본다
        // (그렇지 않으면 복구 시 삽입한 문자가 \\r 뒤에 붙어서, \\r가 문자열 안에
        //  raw control character로 남아 다시 파싱에 실패한다)
        let realEnd = endIndex;
        if (realEnd > 0 && text[realEnd - 1] === '\\r') realEnd--;
        if (!lineStartInString && inString) {
          unresolvedQuoteLineEnd = realEnd;
        } else if (lineStartInString && !inString) {
          unresolvedQuoteLineEnd = -1;
        }
        lineStartInString = inString;
      }

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\n') {
          handleLineEnd(i);
          continue;
        }
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === '\\\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
            // 문자열이 정상적으로 닫혔어도, 다음 항목과 콤마 없이 바로 붙어있는 경우가 있다
            // (예: "benefit_name" : "..." 다음 줄에 "benefit_start_datetime" : ... 처럼
            //  콤마 자체가 통째로 빠진 실수). 따옴표/괄호는 멀쩡해서 기존 검사로는 못 잡히므로
            // 문자열이 닫힐 때마다 바로 다음 유효 토큰이 무엇인지 확인한다.
            let k = i + 1;
            while (k < text.length && /[ \\t\\r\\n]/.test(text[k])) k++;
            const nextCh = text[k];
            if (nextCh !== undefined && nextCh !== ',' && nextCh !== '}' && nextCh !== ']' && nextCh !== ':') {
              issues.push({ message: '여기서 콤마(,)가 빠져서 다음 항목과 붙어있습니다', index: i + 1 });
              insertions.push({ index: i + 1, char: ',' });
            }
          }
          continue;
        }
        if (ch === ' ' || ch === '\\t' || ch === '\\r') {
          continue;
        }
        if (ch === ':') {
          // 콜론 다음에 오는 값이 따옴표/객체/배열/숫자/true·false·null(대소문자 무관)
          // 중 무엇도 아니면, 문자열 값인데 여는 따옴표가 빠진 것으로 본다. 이걸 그냥
          // 두면 뒤에 있는 진짜 닫는 따옴표를 여는 따옴표로 착각해서 그 다음부터
          // 전부 잘못 해석된다.
          let k = i + 1;
          while (k < text.length && /[ \\t\\r\\n]/.test(text[k])) k++;
          const startCh = text[k];
          if (startCh !== undefined) {
            const isQuote = startCh === '"';
            const isBracket = startCh === '{' || startCh === '[';
            const isNumberStart = /[0-9\\-]/.test(startCh);
            const restSlice = text.slice(k, k + 5).toLowerCase();
            const isBooleanOrNull = restSlice.indexOf('true') === 0 || restSlice.indexOf('false') === 0 || restSlice.indexOf('null') === 0;
            if (!isQuote && !isBracket && !isNumberStart && !isBooleanOrNull) {
              issues.push({ message: '여기서 " 가 빠져서 문자열이 아닌 값으로 잘못 해석되고 있습니다', index: k });
              insertions.push({ index: k, char: '"' });
            }
          }
          lastNonSpaceChar = ch;
          continue;
        }
        if (ch === '"') {
          inString = true;
          lastNonSpaceChar = ch;
          continue;
        }
        if (ch === '{' || ch === '[') {
          stack.push({ char: ch, index: i, viaColon: lastNonSpaceChar === ':' });
          lastNonSpaceChar = ch;
          continue;
        }
        if (ch === '}' || ch === ']') {
          const expected = ch === '}' ? '{' : '[';
          if (stack.length > 0 && stack[stack.length - 1].char === expected) {
            const popped = stack.pop();
            if (popped.viaColon) {
              // "key": {...} 다음에 콤마를 찍고 새 키(따옴표) 없이 바로 { 또는 [ 가 나오면,
              // 배열 대괄호 [ ] 가 통째로 빠져서 여러 객체가 한 값처럼 잘못 이어붙은 것으로
              // 본다. 이 값이 시작되는 위치에 가상의 [ 를 끼워 넣어 이후 스캔을 배열로
              // 인식시킨다 (짝이 되는 닫는 ] 는 뒤에서 기존 짝 안맞음 로직이 자연스럽게 잡아줌)
              let k = i + 1;
              while (k < text.length && /[ \\t\\r\\n]/.test(text[k])) k++;
              if (text[k] === ',') {
                let k2 = k + 1;
                while (k2 < text.length && /[ \\t\\r\\n]/.test(text[k2])) k2++;
                if (text[k2] === '{' || text[k2] === '[') {
                  issues.push({ message: '여기서 [ 가 빠져서 배열이 아닌 객체(들)로 잘못 해석되고 있습니다', index: popped.index });
                  insertions.push({ index: popped.index, char: '[' });
                  stack.push({ char: '[', index: popped.index, virtual: true });
                }
              }
            }
            lastNonSpaceChar = ch;
            continue;
          }
          if (stack.length > 0) {
            // 스택 맨 위가 먼저 닫혔어야 함 -> 지금 위치에 그 닫는 문자를 끼워 넣도록 기록
            const top = stack.pop();
            const missingClose = top.char === '{' ? '}' : ']';
            issues.push({ message: '여기서 ' + missingClose + ' 가 빠져서 짝이 어긋났습니다', index: i });
            insertions.push({ index: i, char: missingClose });
            // 지금 문자가 그 다음 스택과 맞는지도 이어서 확인
            if (stack.length > 0 && stack[stack.length - 1].char === expected) {
              stack.pop();
            } else {
              issues.push({ message: '짝이 맞지 않는 여분의 ' + ch + ' 가 있습니다', index: i });
            }
          } else {
            issues.push({ message: '짝이 맞지 않는 여분의 ' + ch + ' 가 있습니다', index: i });
          }
          lastNonSpaceChar = ch;
          continue;
        }
        lastNonSpaceChar = ch;
      }
      handleLineEnd(text.length);

      if (inString) {
        const pos = unresolvedQuoteLineEnd !== -1 ? unresolvedQuoteLineEnd : text.length;
        issues.push({ message: '문자열이 닫히지 않았습니다 - 이 줄 끝에 닫는 따옴표가 빠진 것으로 보입니다', index: pos });
        // 닫는 따옴표만 넣으면 되는지, 다음 필드와의 콤마도 같이 빠졌는지 확인해서 같이 채운다
        let insertText = '"';
        let k = pos;
        while (k < text.length && /[ \\t\\r\\n]/.test(text[k])) k++;
        const nextCh = text[k];
        if (nextCh !== undefined && nextCh !== ',' && nextCh !== '}' && nextCh !== ']' && nextCh !== ':') {
          insertText += ',';
        }
        insertions.push({ index: pos, char: insertText });
      }

      stack.slice().reverse().forEach(function (entry) {
        const missingClose = entry.char === '{' ? '}' : ']';
        issues.push({ message: '문서 끝까지 닫히지 않았습니다 - 닫는 ' + missingClose + ' 가 빠짐', index: text.length });
        insertions.push({ index: text.length, char: missingClose });
      });

      return { issues: issues, insertions: insertions };
    }

    // 표준 JSON은 소문자 null만 인정하는데, 실무에서는 Null/NULL처럼 대소문자가
    // 섞여 들어오는 경우가 있다. 문자열 내부는 건드리지 않고, 문자열 밖에서
    // 대소문자 구분 없이 "null" 단어를 찾으면 표준 소문자로 바꿔준다.
    function normalizeNullLiterals(text) {
      let result = '';
      let inString = false;
      let escape = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          result += ch;
          if (escape) {
            escape = false;
          } else if (ch === '\\\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          result += ch;
          continue;
        }
        if (ch === 'n' || ch === 'N') {
          const slice = text.slice(i, i + 4).toLowerCase();
          if (slice === 'null') {
            const before = i > 0 ? text[i - 1] : '';
            const after = text[i + 4] || '';
            const isWordChar = function (c) { return /[A-Za-z0-9_$]/.test(c); };
            if (!isWordChar(before) && !isWordChar(after)) {
              result += 'null';
              i += 3;
              continue;
            }
          }
        }
        result += ch;
      }
      return result;
    }

    function applyInsertions(text, insertions) {
      if (!insertions || insertions.length === 0) return text;
      const sorted = insertions.slice().sort(function (a, b) { return b.index - a.index; });
      let result = text;
      sorted.forEach(function (ins) {
        result = result.slice(0, ins.index) + ins.char + result.slice(ins.index);
      });
      return result;
    }

    // applyInsertions와 동일하지만, 삽입한 문자들이 원문 어느 위치에서 왔는지 계속
    // 추적할 수 있도록 인덱스 매핑 배열도 같이 갱신해서 반환한다.
    function applyInsertionsWithMapping(text, insertions, mapping) {
      const sorted = insertions.slice().sort(function (a, b) { return a.index - b.index; });
      let resultText = '';
      const resultMapping = [];
      let cursor = 0;
      sorted.forEach(function (ins) {
        resultText += text.slice(cursor, ins.index);
        for (let p = cursor; p < ins.index; p++) resultMapping.push(mapping[p]);
        const anchorOrig = ins.index < mapping.length
          ? mapping[ins.index]
          : (mapping.length > 0 ? mapping[mapping.length - 1] + 1 : ins.index);
        for (let c = 0; c < ins.char.length; c++) {
          resultText += ins.char[c];
          resultMapping.push(anchorOrig);
        }
        cursor = ins.index;
      });
      resultText += text.slice(cursor);
      for (let p = cursor; p < text.length; p++) resultMapping.push(mapping[p]);
      return { text: resultText, mapping: resultMapping };
    }

    // 원문 화면에 보여줄 진단 목록을 만든다. diagnoseStructure는 한 번 훑을 때 발견되는
    // 문제를 전부 보고하는데, 앞쪽에서 따옴표/괄호가 하나라도 깨지면 그 뒤 전체가 잘못
    // 해석되어 실제로는 문제 없는 부분까지 대량의 오탐(가짜 콤마 누락 등)으로 쏟아질 수
    // 있다. 그래서 한 패스마다 "이번에 실제로 고친 것"만 원문 기준 위치로 변환해서 채택하고,
    // 고친 뒤 다시 진단하는 과정을 반복해서 진짜 남아있는 문제만 정확한 위치로 보여준다.
    function diagnoseForDisplay(text) {
      const finalIssues = [];
      let current = text;
      let mapping = [];
      for (let p = 0; p < text.length; p++) mapping.push(p);

      function toOriginalIndex(idx) {
        if (idx === null || idx === undefined) return idx;
        if (idx < mapping.length) return mapping[idx];
        return mapping.length > 0 ? mapping[mapping.length - 1] + 1 : idx;
      }

      for (let pass = 0; pass < 8; pass++) {
        const d = diagnoseStructure(current);
        if (d.issues.length === 0) break;

        if (d.insertions.length === 0) {
          // 삽입만으로는 못 고치는 문제(예: 여분의 닫는 괄호)만 남은 경우 -
          // 더 반복해도 나아지지 않으므로 남은 문제를 그대로 보여주고 끝낸다
          d.issues.forEach(function (issue) {
            finalIssues.push({ message: issue.message, index: toOriginalIndex(issue.index) });
          });
          break;
        }

        const quoteFixes = d.insertions.filter(function (ins) {
          return ins.char.indexOf('"') !== -1;
        });
        const toApply = quoteFixes.length > 0 ? quoteFixes : d.insertions;
        const toApplyIndexes = {};
        toApply.forEach(function (ins) { toApplyIndexes[ins.index] = true; });

        d.issues.forEach(function (issue) {
          if (!toApplyIndexes[issue.index]) return;
          finalIssues.push({ message: issue.message, index: toOriginalIndex(issue.index) });
        });

        const applied = applyInsertionsWithMapping(current, toApply, mapping);
        if (applied.text === current) break;
        current = applied.text;
        mapping = applied.mapping;
      }

      return finalIssues;
    }

    // 문자열이 안 닫혀 있으면 그 뒤의 중괄호/대괄호 개수 자체가 부정확하게 잡히기 때문에,
    // 따옴표 문제부터 먼저 고치고 다시 진단하는 식으로 여러 단계에 걸쳐 복구를 시도한다.
    // null 대소문자 정규화는 문자열 경계가 맞아야 정확하므로(안 닫힌 문자열이 있으면
    // 그 뒤의 Null까지 "문자열 안"으로 착각해서 정규화를 건너뜀) 구조 복구를 마친 뒤에 한다.
    function repairAndParse(text) {
      let current = text;
      for (let pass = 0; pass < 5; pass++) {
        const d = diagnoseStructure(current);
        if (d.insertions.length === 0) break;
        const quoteInsertions = d.insertions.filter(function (ins) {
          return ins.char.indexOf('"') !== -1;
        });
        const toApply = quoteInsertions.length > 0 ? quoteInsertions : d.insertions;
        const next = applyInsertions(current, toApply);
        if (next === current) break;
        current = next;
        try {
          return JSON.parse(normalizeNullLiterals(current));
        } catch (e) {
          // 다음 패스로 계속
        }
      }
      try {
        return JSON.parse(normalizeNullLiterals(current));
      } catch (e) {
        return null;
      }
    }

    const RUBICON_ID = 'benefits-data';
    const results = [];
    const scriptEl = document.getElementById(RUBICON_ID);
    if (!scriptEl) {
      return results;
    }

    const groupKey = '#' + scriptEl.id;
    const path = cssPath(scriptEl);
    const rawText = scriptEl.textContent;
    const structuralIssues = diagnoseForDisplay(rawText);

    // 문법 유효성과 관계없이 원문 내용을 그대로 노출하고, 구조적 문제(따옴표/괄호)도 정확한 위치와 함께 진단
    results.push({
      kind: 'raw',
      label: '루비콘 원문',
      path: path,
      group: groupKey,
      text: rawText,
      structuralIssues: structuralIssues,
      attrs: []
    });

    // 파싱이 되면 필드별로도 추가로 보여준다.
    // 문법이 깨져 있어도(닫는 따옴표/괄호 누락) 최대한 복구를 시도해서
    // 기본 정보/benefits 목록이 계속 보이도록 한다.
    (function tryParse() {
      function attempt(text) {
        try {
          return JSON.parse(text);
        } catch (e) {
          let cleaned = text.replace(/,(\\s*[}\\]])/g, '$1');
          cleaned = normalizeNullLiterals(cleaned);
          try {
            return JSON.parse(cleaned);
          } catch (e2) {
            return null;
          }
        }
      }

      let data = attempt(rawText);

      if (!data) {
        // 원문 진단 결과(어긋난 위치의 따옴표/괄호)를 근거로 정확한 위치에 채워 넣어
        // 단계적으로 재시도한다 (문자열을 먼저 닫아야 그 뒤의 괄호가 제대로 보이므로)
        data = repairAndParse(rawText);
      }

      if (!data || typeof data !== 'object') return;

      const baseAttrs = [];
      Object.keys(data).forEach(function (key) {
        const val = data[key];
        if (val === null || typeof val !== 'object') {
          // null(대소문자 무관, 따옴표 없는 리터럴)은 "값이 비어서 누락"이 아니라
          // "기간이 없다" 같은 의도적인 값으로 쓰이므로 빈값으로 표시하지 않는다.
          const isNullValue = val === null;
          baseAttrs.push({
            attr: key,
            value: isNullValue ? 'null' : (val === undefined ? '' : String(val)),
            empty: isNullValue ? false : isEmptyVal(val),
            issues: validateValue(key, val)
          });
        }
      });
      if (baseAttrs.length > 0) {
        results.push({ kind: 'json', label: '기본 정보', path: path, group: groupKey, attrs: baseAttrs });
      }

      Object.keys(data).forEach(function (key) {
        const val = data[key];
        if (Array.isArray(val)) {
          val.forEach(function (item, idx) {
            if (item && typeof item === 'object') {
              const attrs = [];
              Object.keys(item).forEach(function (k2) {
                const v2 = item[k2];
                if (v2 === null || typeof v2 !== 'object') {
                  // null(대소문자 무관, 따옴표 없는 리터럴)은 "값이 비어서 누락"이 아니라
                  // "기간이 없다" 같은 의도적인 값으로 쓰이므로 빈값으로 표시하지 않는다.
                  const isNullValue = v2 === null;
                  attrs.push({
                    attr: k2,
                    value: isNullValue ? 'null' : (v2 === undefined ? '' : String(v2)),
                    empty: isNullValue ? false : isEmptyVal(v2),
                    issues: validateValue(k2, v2)
                  });
                }
              });
              results.push({ kind: 'json', label: key + ' #' + (idx + 1), path: path, group: groupKey, attrs: attrs });
            }
          });
        }
      });
    })();
    return results;
  })()`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indexToLineCol(text, index) {
  if (index === null || index === undefined || index < 0) return null;
  const upto = text.slice(0, index);
  const lines = upto.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function buildHighlightedRawHtml(text, issues) {
  const points = (issues || [])
    .filter((issue) => issue.index !== null && issue.index !== undefined && issue.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (points.length === 0) return escapeHtml(text);

  // 실제 글자를 감싸서 색을 바꾸는 대신, 문제 위치 바로 앞에 노란 경고 아이콘을 끼워 넣는다
  // (원문 가독성은 유지하면서 정확한 지점은 표시)
  let html = '';
  let last = 0;
  points.forEach((issue) => {
    const idx = Math.min(issue.index, text.length);
    if (idx < last) return;
    html += escapeHtml(text.slice(last, idx));
    html += `<span class="warn-marker" title="${escapeHtml(issue.message)}">⚠</span>`;
    last = idx;
  });
  html += escapeHtml(text.slice(last));
  return html;
}

function focusInspectedWindow() {
  chrome.tabs.get(chrome.devtools.inspectedWindow.tabId, (tab) => {
    if (tab && tab.windowId != null) {
      chrome.windows.update(tab.windowId, { focused: true });
    }
  });
}

function domJumpScript(path) {
  return `(function () {
    const el = document.querySelector(${JSON.stringify(path)});
    if (!el) { inspect(el); return; }

    // 이전에 남아있는 하이라이트가 있으면 먼저 정리
    if (window.__qaHighlight) {
      const prev = window.__qaHighlight;
      prev.el.style.outline = prev.prevOutline;
      prev.el.style.outlineOffset = prev.prevOffset;
      clearTimeout(prev.timer);
      document.removeEventListener('click', prev.clickHandler, true);
      window.__qaHighlight = null;
    }

    function inViewport(node) {
      const rect = node.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      return rect.top >= 0 && rect.bottom <= vh;
    }

    function centerOffset(node) {
      const rect = node.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      return (rect.top + rect.bottom) / 2 - vh / 2;
    }

    function flash() {
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = '3px solid #ff3b30';
      el.style.outlineOffset = '2px';

      function clearHighlight() {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
        document.removeEventListener('click', clickHandler, true);
        if (window.__qaHighlight && window.__qaHighlight.el === el) {
          window.__qaHighlight = null;
        }
      }

      function clickHandler() {
        clearTimeout(timer);
        clearHighlight();
      }

      const timer = setTimeout(clearHighlight, 1600);
      document.addEventListener('click', clickHandler, true);
      window.__qaHighlight = { el: el, prevOutline: prevOutline, prevOffset: prevOffset, timer: timer, clickHandler: clickHandler };
    }

    // 일반 페이지: 네이티브 스크롤 우선 시도
    el.scrollIntoView({ behavior: 'auto', block: 'center' });

    // Swiper/패럴렉스 등 커스텀 스크롤 라이브러리 대응:
    // 실제 wheel 이벤트를 흉내 내서 라이브러리가 반응하도록 유도
    let attempts = 0;
    const maxAttempts = 40;
    const timer = setInterval(function () {
      attempts++;
      if (inViewport(el) || attempts >= maxAttempts) {
        clearInterval(timer);
        flash();
        inspect(el);
        return;
      }
      const offset = centerOffset(el);
      const deltaY = Math.max(-120, Math.min(120, offset));
      document.body.dispatchEvent(new WheelEvent('wheel', {
        deltaY: deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2
      }));
    }, 50);
  })()`;
}

function jumpToItem(item) {
  focusInspectedWindow();
  if (item.kind === 'dom' || item.scrollable) {
    chrome.devtools.inspectedWindow.eval(domJumpScript(item.path));
  } else {
    // json/raw: 화면에 보이지 않는 블록이므로 스크롤/하이라이트 없이 Elements 패널에서만 선택
    chrome.devtools.inspectedWindow.eval(
      `inspect(document.querySelector(${JSON.stringify(item.path)}))`
    );
  }
}

function bindToggleClass(detailsEl) {
  const applyState = () => {
    detailsEl.classList.toggle('is-open', detailsEl.open);
    const arrow = detailsEl.querySelector(':scope > summary > .arrow');
    if (arrow) {
      arrow.style.transform = detailsEl.open ? 'rotate(90deg)' : 'rotate(0deg)';
    }
  };
  applyState();
  detailsEl.addEventListener('toggle', applyState);
}

function buildEventNumberScanScript(scanScopeSelector) {
  return `(function () {
    ${INJECTED_HELPERS}
    const scanScopeSelector = ${JSON.stringify(scanScopeSelector)};
    function isInScope(el) {
      if (!scanScopeSelector) return true;
      let cur = el;
      while (cur) {
        if (cur.matches && cur.matches(scanScopeSelector)) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    // 이벤트 팝업/응모 처리 함수들 - 첫 번째 인자가 "이벤트 번호"
    const FN_NAMES = ['fnCallPop2', 'fnCallPop7', 'fnCallPop8', 'fnCallPop14', 'fnCheckWinConstraints'];

    function extractCalls(text) {
      const found = [];
      FN_NAMES.forEach(function (name) {
        const marker = name + '(';
        let searchFrom = 0;
        while (true) {
          const idx = text.indexOf(marker, searchFrom);
          if (idx === -1) break;
          const argStart = idx + marker.length;
          let end = argStart;
          while (end < text.length && text[end] !== ',' && text[end] !== ')') end++;
          let rawArg = text.slice(argStart, end).trim();
          if (
            (rawArg.charAt(0) === '"' && rawArg.charAt(rawArg.length - 1) === '"') ||
            (rawArg.charAt(0) === "'" && rawArg.charAt(rawArg.length - 1) === "'")
          ) {
            rawArg = rawArg.slice(1, -1);
          }
          found.push({ fn: name, value: rawArg, empty: rawArg === '', index: idx });
          searchFrom = end + 1;
        }
      });
      return found;
    }

    // 스크립트 코드 안에서 matchPos 지점을 감싸고 있는 가장 가까운
    // 'var/let/const 이름 = { ... }' 또는 'var/let/const 이름 = function ... { ... }'
    // 이름을 찾는다 (예: getEvent.done 콜백 안의 fnCallPop14 호출 -> 'getEvent')
    function findEnclosingHandlerName(text, matchPos) {
      const braceStack = [];
      let pendingName = null;
      let inString = false;
      let stringChar = '';
      let escape = false;
      const isWordChar = function (c) { return /[A-Za-z0-9_$]/.test(c); };

      for (let i = 0; i < matchPos && i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escape) { escape = false; }
          else if (ch === '\\\\') { escape = true; }
          else if (ch === stringChar) { inString = false; }
          continue;
        }
        if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }

        if (text.startsWith('var ', i) || text.startsWith('let ', i) || text.startsWith('const ', i)) {
          const markerLen = text.startsWith('const ', i) ? 6 : 4;
          let p = i + markerLen;
          while (p < text.length && /\\s/.test(text[p])) p++;
          const nameStart = p;
          while (p < text.length && isWordChar(text[p])) p++;
          const name = text.slice(nameStart, p);
          if (name) {
            let q = p;
            while (q < text.length && /\\s/.test(text[q])) q++;
            if (text[q] === '=') pendingName = name;
          }
          continue;
        }
        if (ch === '{') {
          braceStack.push({ name: pendingName });
          pendingName = null;
          continue;
        }
        if (ch === '}') {
          if (braceStack.length > 0) braceStack.pop();
          continue;
        }
        if (ch === ';' && pendingName !== null) {
          pendingName = null;
        }
      }

      for (let k = braceStack.length - 1; k >= 0; k--) {
        if (braceStack[k].name) return braceStack[k].name;
      }
      return null;
    }

    // 페이지에서 이 이름을 onclick 등에서 실제로 호출/참조하는 요소를 찾는다
    // (예: onclick="ajax.call(getEvent)" 처럼 이름이 그대로 쓰인 요소)
    function findTriggerElement(name) {
      if (!name) return null;
      const isWordChar = function (c) { return /[A-Za-z0-9_$]/.test(c); };
      const candidates = document.querySelectorAll('[onclick]');
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const text = el.getAttribute('onclick') || '';
        let idx = text.indexOf(name);
        while (idx !== -1) {
          const before = idx > 0 ? text[idx - 1] : '';
          const after = idx + name.length < text.length ? text[idx + name.length] : '';
          if (!isWordChar(before) && !isWordChar(after)) {
            return el;
          }
          idx = text.indexOf(name, idx + 1);
        }
      }
      return null;
    }

    // data-cpNum 은 HTML 파싱 시 항상 소문자(data-cpnum)로 저장됨
    const EVENT_ATTRS = ['data-popup-target', 'data-cpnum'];
    const results = [];

    // 1) DOM 요소: onclick 안의 이벤트 함수 호출 + data-popup-target / data-cpNum 속성
    document.querySelectorAll('*').forEach(function (el) {
      if (!isInScope(el)) return;
      const matched = [];
      const onclickText = el.getAttribute('onclick');
      if (onclickText) {
        extractCalls(onclickText).forEach(function (c) {
          matched.push({ attr: c.fn + '() 인자', value: c.value, empty: c.empty });
        });
      }
      EVENT_ATTRS.forEach(function (attr) {
        if (el.hasAttribute(attr)) {
          const value = el.getAttribute(attr);
          matched.push({ attr: attr, value: value, empty: isEmptyVal(value) });
        }
      });
      if (matched.length > 0) {
        results.push({
          kind: 'dom',
          label: el.tagName.toLowerCase(),
          path: cssPath(el),
          group: findGroup(el),
          attrs: matched
        });
      }
    });

    // 2) <script> 태그 안의 인라인 JS 코드에 있는 이벤트 함수 호출
    //    (예: ajax 콜백 안에서 fnCallPop14(3374) 처럼 onclick이 아니라 JS 코드 자체에 있는 경우)
    //    한 스크립트 안에 여러 콜백(핸들러)이 섞여 있을 수 있어서, 호출들을
    //    "이 호출을 감싸는 핸들러 이름"별로 따로 묶어야 트리거 요소와 스코프 체크가 정확해진다.
    document.querySelectorAll('script').forEach(function (scriptEl) {
      const text = scriptEl.textContent || '';
      const calls = extractCalls(text);
      if (calls.length === 0) return;

      const groups = [];
      calls.forEach(function (c) {
        const handlerName = findEnclosingHandlerName(text, c.index);
        const key = handlerName || '__no_handler__';
        let group = null;
        for (let gi = 0; gi < groups.length; gi++) {
          if (groups[gi].key === key) { group = groups[gi]; break; }
        }
        if (!group) {
          group = { key: key, triggerEl: handlerName ? findTriggerElement(handlerName) : null, calls: [] };
          groups.push(group);
        }
        group.calls.push(c);
      });

      groups.forEach(function (group) {
        // 트리거 요소를 찾았고 그게 스캔 범위(.sec_project_wrap) 안에 있는 경우만 포함
        if (scanScopeSelector && !(group.triggerEl && isInScope(group.triggerEl))) return;

        const attrs = group.calls.map(function (c) {
          return { attr: c.fn + '() 인자', value: c.value, empty: c.empty };
        });

        const label = scriptEl.id ? 'Script#' + scriptEl.id : 'Inline Script';
        const triggerEl = group.triggerEl;
        results.push({
          kind: 'json',
          scrollable: true,
          label: triggerEl ? label + ' → <' + triggerEl.tagName.toLowerCase() + '>' : label,
          path: triggerEl ? cssPath(triggerEl) : cssPath(scriptEl),
          group: 'Script',
          attrs: attrs
        });
      });
    });

    return results;
  })()`;
}

function buildAnchoredUrlScanScript(scanScopeSelector) {
  return `(function () {
    ${INJECTED_HELPERS}
    const scanScopeSelector = ${JSON.stringify(scanScopeSelector)};
    function isInScope(el) {
      if (!scanScopeSelector) return true;
      let cur = el;
      while (cur) {
        if (cur.matches && cur.matches(scanScopeSelector)) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    // 괄호/중괄호 짝이 안 맞아도 상관없이, "url:" 이 나오는 지점을 기준으로
    // 한 항목의 시작으로 보고 그 다음 "url:" 전까지의 범위 안에서
    // target:/click: 값을 문자열로 찾아낸다 (문법 검증은 하지 않음).
    function extractFieldValue(text, fieldName, fromIdx, toIdx) {
      const marker = fieldName + ':';
      const idx = text.indexOf(marker, fromIdx);
      if (idx === -1 || idx >= toIdx) return null;
      let p = idx + marker.length;
      while (p < text.length && /[ \\t\\r\\n]/.test(text[p])) p++;
      const quote = text[p];
      if (quote === '"' || quote === "'") {
        let end = p + 1;
        let escape = false;
        while (end < text.length && end < toIdx) {
          if (escape) { escape = false; end++; continue; }
          if (text[end] === '\\\\') { escape = true; end++; continue; }
          if (text[end] === quote) break;
          end++;
        }
        return text.slice(p + 1, end);
      }
      // 따옴표 없이 온 값(숫자, 배열 등)이면 콤마/줄바꿈/닫는 괄호 전까지만
      let end = p;
      while (end < text.length && end < toIdx && ',\\n}]'.indexOf(text[end]) === -1) end++;
      return text.slice(p, end).trim();
    }

    const results = [];

    // src가 있는 <script>는 textContent가 항상 비어있으므로(브라우저가 인라인 내용을
    // 실행하지 않음), 같은 origin이면 동기 XHR로 실제 파일 내용을 읽어와서 검사한다
    // (file://는 보안상 요청이 막히지만 http(s)/localhost는 same-origin이라 막히지 않음).
    const scriptEls = document.querySelectorAll('script');
    for (let si = 0; si < scriptEls.length; si++) {
      const scriptEl = scriptEls[si];
      let text = '';
      if (scriptEl.src) {
        // 다른 도메인(GA/GTM/CDN 라이브러리 등) 스크립트는 어차피 CORS로 막혀서
        // 시도해봐야 네트워크 왕복 시간만 낭비되므로, 같은 origin일 때만 시도한다.
        let sameOrigin = false;
        try { sameOrigin = new URL(scriptEl.src, location.href).origin === location.origin; } catch (e) {}
        if (sameOrigin) text = fetchScriptTextSync(scriptEl.src);
      } else {
        text = scriptEl.textContent || '';
      }
      if (!text) continue;

      const callIdx = text.indexOf('anchor.load(');
      if (callIdx === -1) continue;

      const urlPositions = [];
      let searchFrom = callIdx;
      while (true) {
        const idx = text.indexOf('url:', searchFrom);
        if (idx === -1) break;
        urlPositions.push(idx);
        searchFrom = idx + 4;
      }
      if (urlPositions.length === 0) continue;

      urlPositions.forEach(function (startIdx, i) {
        const endIdx = i + 1 < urlPositions.length ? urlPositions[i + 1] : text.length;
        const url = extractFieldValue(text, 'url', startIdx, endIdx);
        const target = extractFieldValue(text, 'target', startIdx, endIdx);
        const click = extractFieldValue(text, 'click', startIdx, endIdx);

        const attrs = [
          { attr: 'url', value: url, empty: isEmptyVal(url), missing: url === null },
          { attr: 'target', value: target, empty: isEmptyVal(target), missing: target === null }
        ];
        // click은 없어도 무방한 선택 속성이라, 값이 있을 때만 표에 보여준다
        if (click !== null) {
          attrs.push({ attr: 'click', value: click, empty: isEmptyVal(click), missing: false });
        }

        const label = url ? url : ('entry #' + (i + 1));

        // target 셀렉터로 실제 페이지 요소를 찾으면 그쪽으로 "찾기" 이동,
        // 못 찾으면(또는 target이 없으면) 스크립트 태그로 폴백
        let jumpPath = cssPath(scriptEl);
        let scrollable = false;
        let targetEl = null;
        if (target) {
          try {
            targetEl = document.querySelector(target);
            if (targetEl) {
              jumpPath = cssPath(targetEl);
              scrollable = true;
            }
          } catch (e) {
            // 잘못된 셀렉터면 그냥 스크립트 태그로 폴백
          }
        }

        // target이 스캔 범위(.sec_project_wrap) 안에 있는 경우만 결과에 포함
        if (scanScopeSelector && !(targetEl && isInScope(targetEl))) return;

        results.push({
          kind: 'json',
          scrollable: scrollable,
          label: label,
          path: jumpPath,
          group: 'Anchor Load',
          attrs: attrs
        });
      });
    }

    return results;
  })()`;
}

const TABS = {
  dom: { label: '속성 검사', build: () => buildDomScanScript(ATTRS, ONCLICK_FNS, REQUIRED_ATTRS_BY_TAG, SCAN_SCOPE_SELECTOR) },
  rubicon: { label: '루비콘', build: () => buildRubiconScanScript() },
  eventNumber: { label: '이벤트 번호', build: () => buildEventNumberScanScript(SCAN_SCOPE_SELECTOR) },
  anchoredUrl: { label: '앵커드URL', build: () => buildAnchoredUrlScanScript(SCAN_SCOPE_SELECTOR) }
};

// 탭별로 알려줘야 할 환경적 한계 안내 (버그가 아니라 로컬 환경 제약임을 명시)
const TAB_NOTICES = {
  anchoredUrl: '※ 외부 .js 파일(script src) 안의 anchor.load도 같은 origin이면 읽어옵니다. 단, 페이지를 file://로 직접 열면 보안 정책상 외부 파일 요청이 막혀서 못 찾을 수 있습니다 (localhost 등 서버로 열면 정상 스캔됨).'
};

let currentTab = 'dom';
const resultsByTab = { dom: [], rubicon: [], eventNumber: [], anchoredUrl: [] };

function updateTabNotice() {
  const notice = document.getElementById('tabNotice');
  const message = TAB_NOTICES[currentTab];
  if (message) {
    notice.textContent = message;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

function render() {
  const container = document.getElementById('resultContainer');
  const emptyOnly = document.getElementById('emptyOnly').checked;
  const lastResults = resultsByTab[currentTab];

  const sections = new Map();
  lastResults.forEach((elItem) => {
    if (!sections.has(elItem.group)) sections.set(elItem.group, []);
    sections.get(elItem.group).push(elItem);
  });

  container.innerHTML = '';

  let totalAttrs = 0;
  let emptyAttrs = 0;
  lastResults.forEach((elItem) => {
    elItem.attrs.forEach((a) => {
      totalAttrs++;
      if (a.empty) emptyAttrs++;
    });
  });

  if (lastResults.length === 0) {
    container.innerHTML = '<div class="empty-state">스캔 결과가 없습니다.</div>';
  }

  sections.forEach((elements, groupKey) => {
    const sectionTotal = elements.reduce((sum, e) => sum + e.attrs.length, 0);
    const sectionEmpty = elements.reduce((sum, e) => sum + e.attrs.filter((a) => a.empty).length, 0);
    const visibleElements = emptyOnly
      ? elements.filter((e) => e.attrs.some((a) => a.empty))
      : elements;

    if (emptyOnly && visibleElements.length === 0) return;

    const sectionDetails = document.createElement('details');
    sectionDetails.className = 'group';

    const sectionSummary = document.createElement('summary');
    sectionSummary.innerHTML = `
      <span class="arrow">▶</span>
      <span class="group-label">${escapeHtml(groupKey)}</span>
      <span class="group-count">요소 ${elements.length}개 · 속성 ${sectionTotal}개</span>
      ${sectionEmpty > 0
        ? `<span class="badge badge-empty">빈값 ${sectionEmpty}</span>`
        : `<span class="badge badge-filled">전체 채워짐</span>`}
    `;
    sectionDetails.appendChild(sectionSummary);
    bindToggleClass(sectionDetails);

    const elementList = document.createElement('div');
    elementList.className = 'element-list';

    visibleElements.forEach((elItem) => {
      const elDetails = document.createElement('details');
      elDetails.className = 'element';
      elDetails.open = elItem.kind === 'raw';

      const elSummary = document.createElement('summary');

      if (elItem.kind === 'raw') {
        const structuralIssues = elItem.structuralIssues || [];
        elSummary.innerHTML = `
          <span class="arrow">▶</span>
          <span class="tag-badge">${escapeHtml(elItem.label)}</span>
          ${structuralIssues.length > 0
            ? `<span class="badge badge-empty">⚠ 구조 오류 ${structuralIssues.length}건</span>`
            : `<span class="badge badge-filled">구조 정상</span>`}
          <button class="jump-btn">찾기</button>
        `;
        elSummary.querySelector('.jump-btn').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          jumpToItem(elItem);
        });
        elDetails.appendChild(elSummary);
        bindToggleClass(elDetails);

        if (structuralIssues.length > 0) {
          const diag = document.createElement('ul');
          diag.className = 'diagnosis-list';
          structuralIssues.forEach((issue) => {
            const li = document.createElement('li');
            const loc = indexToLineCol(elItem.text, issue.index);
            li.textContent = loc
              ? `${issue.message} (${loc.line}번째 줄, ${loc.col}번째 칸)`
              : issue.message;
            diag.appendChild(li);
          });
          elDetails.appendChild(diag);
        }

        const pre = document.createElement('pre');
        pre.className = 'raw-text';
        pre.innerHTML = buildHighlightedRawHtml(elItem.text, structuralIssues);
        elDetails.appendChild(pre);

        elementList.appendChild(elDetails);
        return;
      }

      const elEmptyCount = elItem.attrs.filter((a) => a.empty).length;
      const visibleAttrs = emptyOnly ? elItem.attrs.filter((a) => a.empty) : elItem.attrs;

      const labelHtml = elItem.kind === 'dom'
        ? `&lt;${escapeHtml(elItem.label)}&gt;`
        : escapeHtml(elItem.label);
      elSummary.innerHTML = `
        <span class="arrow">▶</span>
        <span class="tag-badge">${labelHtml}</span>
        <span class="group-count">속성 ${elItem.attrs.length}개</span>
        ${elEmptyCount > 0
          ? `<span class="badge badge-empty">빈값 ${elEmptyCount}</span>`
          : `<span class="badge badge-filled">전체 채워짐</span>`}
        <button class="jump-btn">찾기</button>
      `;
      elSummary.querySelector('.jump-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToItem(elItem);
      });
      elDetails.appendChild(elSummary);
      bindToggleClass(elDetails);

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr><th>속성</th><th>값</th><th>상태</th></tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody');

      visibleAttrs.forEach((a) => {
        const issues = a.issues || [];
        const tr = document.createElement('tr');
        tr.className = a.empty ? 'row-empty' : 'row-filled';
        const statusBadge = a.missing
          ? '<span class="badge badge-empty">속성 없음</span>'
          : (a.empty ? '<span class="badge badge-empty">빈값</span>' : '<span class="badge badge-filled">채워짐</span>');
        tr.innerHTML = `
          <td>${escapeHtml(a.attr)}</td>
          <td class="val">${a.missing ? '<em>(속성 자체가 없음)</em>' : escapeHtml(a.value)}</td>
          <td>
            ${statusBadge}
            ${issues.length > 0 ? `<span class="badge badge-warning" title="${escapeHtml(issues.join(', '))}">⚠ ${escapeHtml(issues.join(', '))}</span>` : ''}
          </td>
        `;
        tbody.appendChild(tr);
      });

      elDetails.appendChild(table);
      elementList.appendChild(elDetails);
    });

    sectionDetails.appendChild(elementList);
    container.appendChild(sectionDetails);
  });

  document.getElementById('summary').textContent =
    `전체 ${totalAttrs}개 중 빈값 ${emptyAttrs}개`;
}

function scan(retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 3;
  const tab = TABS[currentTab];
  chrome.devtools.inspectedWindow.eval(tab.build(), (result, isException) => {
    if (isException) {
      // 페이지가 새로고침/이동 중이라 실행 컨텍스트가 아직 준비되지 않은
      // 경우 이런 오류가 잠깐 나타날 수 있어서, 짧게 대기 후 자동 재시도
      if (retriesLeft > 0) {
        setTimeout(() => scan(retriesLeft - 1), 300);
        return;
      }
      console.error(isException);
      const container = document.getElementById('resultContainer');
      const message = (isException && (isException.value || isException.description)) || JSON.stringify(isException);
      container.innerHTML = `<div class="empty-state">스캔 중 오류 발생: ${escapeHtml(message)}</div>`;
      document.getElementById('summary').textContent = '';
      return;
    }
    resultsByTab[currentTab] = result || [];
    render();
  });
}

function switchTab(tabKey) {
  currentTab = tabKey;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabKey);
  });
  updateTabNotice();
  scan();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
});

document.getElementById('scanBtn').addEventListener('click', () => scan());
document.getElementById('emptyOnly').addEventListener('change', render);

// 페이지가 새로고침되거나 다른 주소로 이동하면 자동으로 다시 스캔.
// onNavigated는 페이지 로딩이 끝나기 전(주소가 바뀌는 시점)에 먼저 발생할 수 있어서,
// 고정된 시간만 기다리면 아직 내용이 안 채워진 빈 문서를 스캔하게 될 수 있다.
// document.readyState가 'complete'가 될 때까지 짧은 간격으로 확인하다가 스캔한다.
function waitForPageLoadThenScan(attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = 20;
  chrome.devtools.inspectedWindow.eval('document.readyState', (result, isException) => {
    if (!isException && result === 'complete') {
      scan();
      return;
    }
    if (attemptsLeft > 0) {
      setTimeout(() => waitForPageLoadThenScan(attemptsLeft - 1), 150);
    } else {
      // 너무 오래 기다렸으면 포기하고 그냥 한 번 스캔 시도
      scan();
    }
  });
}

chrome.devtools.network.onNavigated.addListener(() => {
  waitForPageLoadThenScan();
});

scan();
