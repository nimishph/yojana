/**
 * The only hand-written script on a served review page: the selection toolbar. htmx does every
 * request; this script only notices a text selection inside one requirement, shows a small toolbar
 * by it, and asks htmx for the comment form (with the selection as its quote) in a popover there,
 * or for the suggest form in the requirement. Plain ES5-style JavaScript in a raw string: no
 * template literals, so nothing in it is interpolated.
 */
export const SELECTION_SCRIPT = String.raw`
(function () {
  var plan = document.body.getAttribute('data-plan');
  var bar = document.getElementById('selbar');
  var pop = document.getElementById('selpop');
  var picked = null;

  function hideBar() { bar.hidden = true; }
  function hidePop() { pop.hidden = true; pop.textContent = ''; }

  function selectionInRequirement() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    var box = start && start.closest('.text[data-req]');
    if (!box || !end || end.closest('.text[data-req]') !== box) return null;
    var text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text === '') return null;
    return { req: box.getAttribute('data-req'), quote: text, rect: range.getBoundingClientRect() };
  }

  function place(element, rect, below) {
    var top = window.scrollY + (below ? rect.bottom + 8 : rect.top - 44);
    var left = Math.max(16, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - element.offsetWidth - 16));
    element.style.top = top + 'px';
    element.style.left = left + 'px';
  }

  var pending = false;
  document.addEventListener('selectionchange', function () {
    if (pending || pop.contains(document.activeElement)) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      picked = selectionInRequirement();
      if (!picked) { hideBar(); return; }
      bar.hidden = false;
      place(bar, picked.rect, false);
    });
  });

  bar.addEventListener('mousedown', function (event) { event.preventDefault(); });
  bar.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-sel]');
    if (!button || !picked) return;
    var req = encodeURIComponent(picked.req);
    var base = '/plan/' + encodeURIComponent(plan) + '/form/';
    hideBar();
    if (button.getAttribute('data-sel') === 'comment') {
      var rect = picked.rect;
      htmx.ajax('GET', base + 'comment/' + req + '?quote=' + encodeURIComponent(picked.quote), { target: '#selpop', swap: 'innerHTML' }).then(function () {
        pop.hidden = false;
        place(pop, rect, true);
        var box = pop.querySelector('textarea');
        if (box) box.focus();
      });
    } else {
      var slot = document.getElementById('slot-' + picked.req.replace(/[^a-zA-Z0-9_-]/g, '-'));
      htmx.ajax('GET', base + 'suggest/' + req, { target: slot, swap: 'innerHTML' }).then(function () {
        slot.scrollIntoView({ block: 'nearest' });
      });
    }
  });

  // A form in the popover that went through closes the popover; so do Cancel, Escape and a click away.
  document.body.addEventListener('htmx:afterRequest', function (event) {
    if (pop.contains(event.target) && event.detail.successful) hidePop();
  });
  pop.addEventListener('click', function (event) {
    var button = event.target.closest('button[type="button"]');
    if (button && button.textContent === 'Cancel') hidePop();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { hideBar(); hidePop(); }
  });
  document.addEventListener('mousedown', function (event) {
    if (!pop.hidden && !pop.contains(event.target) && !bar.contains(event.target)) hidePop();
  });
})();
`;
