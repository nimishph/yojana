/**
 * The script of a served review page (`review --serve`). Plain ES5-style JavaScript in a raw
 * string: no template literals, so nothing in it is interpolated. Text a person types goes into the
 * page only through form values and textContent, never as HTML. Every write is a POST to the local
 * server with the page's token; the server applies the same checks as the CLI and answers with a
 * message, and the page reloads to show the result.
 */
export const LIVE_SCRIPT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('yojana-data').textContent);
  var statusEl = document.getElementById('status');
  var selected = {};

  function say(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? 'error' : '';
    statusEl.hidden = false;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yojana-token': data.token },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (json) { return { status: response.status, body: json }; });
    }).catch(function () {
      return { status: 0, body: { message: 'Could not reach yojana. Is review --serve still running?' } };
    });
  }

  function finish(result) {
    if (result.status === 200) {
      say(result.body.message || 'Saved.');
      setTimeout(function () { location.reload(); }, 700);
      return;
    }
    var message = (result.body && result.body.message) || ('Failed (' + result.status + ').');
    if (result.body && result.body.code === 'STALE' && result.body.current) {
      message += ' It now reads: "' + result.body.current.text + '". Reload to work on the current text.';
    }
    say(message, true);
  }

  // Text selected inside a requirement becomes the quote of a new comment on it.
  document.addEventListener('mouseup', function () {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return;
    var node = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
    var box = node && node.closest('.text[data-req]');
    if (box) selected[box.getAttribute('data-req')] = selection.toString().trim();
  });

  function slot(key) {
    return document.querySelector('[data-slot="' + CSS.escape(key) + '"]');
  }

  function openForm(key, fields, submitLabel, send) {
    var target = slot(key);
    if (!target) return;
    target.textContent = '';
    var form = document.createElement('form');
    form.className = 'inline';
    fields.forEach(function (field) {
      var label = document.createElement('label');
      var caption = document.createElement('span');
      caption.className = 'label';
      caption.textContent = field.label;
      var input = document.createElement(field.multiline ? 'textarea' : 'input');
      input.name = field.name;
      input.value = field.value || '';
      if (field.required) input.required = true;
      label.appendChild(caption);
      label.appendChild(input);
      form.appendChild(label);
    });
    var row = document.createElement('div');
    row.className = 'actions';
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = submitLabel;
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { target.textContent = ''; });
    row.appendChild(submit);
    row.appendChild(cancel);
    form.appendChild(row);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var values = {};
      fields.forEach(function (field) { values[field.name] = form.elements[field.name].value; });
      submit.disabled = true;
      send(values).then(function (result) {
        submit.disabled = false;
        finish(result);
      });
    });
    target.appendChild(form);
    var first = form.querySelector('textarea, input');
    if (first) first.focus();
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var act = button.getAttribute('data-act');
    var req = button.getAttribute('data-req');
    var shown = req ? data.requirements[req] : undefined;

    if (act === 'edit' || act === 'suggest') {
      var fields = [
        { name: 'title', label: 'Title', value: shown.title, required: true },
        { name: 'text', label: 'Text (Markdown)', value: shown.text, multiline: true }
      ];
      if (act === 'suggest') fields.push({ name: 'why', label: 'Why (optional)', multiline: true });
      openForm(req, fields, act === 'edit' ? 'Save to the plan' : 'Open as a change', function (values) {
        return post('/api/' + act, {
          planId: data.planId,
          requirement: req,
          revision: shown.revision,
          title: values.title,
          text: values.text,
          why: values.why
        });
      });
    } else if (act === 'comment') {
      openForm(req, [
        { name: 'body', label: 'Comment', multiline: true, required: true },
        { name: 'quote', label: 'Quote (select text in the requirement to fill this)', value: selected[req] || '' }
      ], 'Comment', function (values) {
        return post('/api/comment', { planId: data.planId, requirement: req, body: values.body, quote: values.quote });
      });
    } else if (act === 'reply') {
      var id = button.getAttribute('data-id');
      openForm(id, [{ name: 'body', label: 'Reply', multiline: true, required: true }], 'Reply', function (values) {
        return post('/api/comment', { planId: data.planId, requirement: req, body: values.body, replyTo: id });
      });
    } else if (act === 'accept') {
      var acceptId = button.getAttribute('data-change');
      openForm('change:' + acceptId, [], 'Accept and apply', function () {
        return post('/api/accept', { changeId: acceptId });
      });
    } else if (act === 'recheck') {
      button.disabled = true;
      say('Refreshing: asking bd again, and re-running claims if the server checks them. This can take a little while.');
      post('/api/check', { planId: data.planId }).then(function (result) {
        button.disabled = false;
        finish(result);
      });
    } else if (act === 'reject') {
      var rejectId = button.getAttribute('data-change');
      openForm('change:' + rejectId, [{ name: 'reason', label: 'Why reject it?', required: true }], 'Reject', function (values) {
        return post('/api/reject', { changeId: rejectId, reason: values.reason });
      });
    }
  });
})();
`;
