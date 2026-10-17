const ro = (navigator.language || '').toLowerCase().startsWith('ro')
const T = ro
  ? { on: 'Conectat la Jolty', off: 'Neconectat', onText: 'Jolty poate lucra în acest browser cât timp butonul Browser e pornit într-o conversație.', offText: 'Pornește aplicația Jolty. Se conectează singură.', retry: 'Reconectează' }
  : { on: 'Connected to Jolty', off: 'Not connected', onText: 'Jolty can work in this browser while the Browser button is on in a chat.', offText: 'Start the Jolty app. It connects by itself.', retry: 'Reconnect' }
const $ = (id) => document.getElementById(id)
$('retry').textContent = T.retry
async function paint() {
  const { state } = await chrome.storage.session.get('state')
  const on = state === 'online'
  $('box').className = 'row' + (on ? ' on' : '')
  $('title').textContent = on ? T.on : T.off
  $('text').textContent = on ? T.onText : T.offText
}
$('retry').onclick = () => chrome.runtime.sendMessage({ type: 'reconnect' }).then(() => setTimeout(paint, 800))
chrome.storage.onChanged.addListener(paint)
void paint()
