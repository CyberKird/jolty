// Test pages served on localhost for the browser tool tests.
export const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Jolty test home</title><body style="font:16px sans-serif">
<h1>Welcome</h1>
<p>Some intro text for the page.</p>
<nav><a href="/form">Open the form</a> | <a href="/popup-target" target="_blank">New tab link</a> | <a href="/slow">Slow page</a></nav>
<button id="count" onclick="this.textContent='Clicked '+(++window.n)">Clicked 0</button>
<script>window.n=0;console.log('home loaded');console.error('a test error')</script>
<div id="far" style="margin-top:2500px"><button onclick="document.title='far clicked'">Far button</button></div>
</body>`,
  '/form': `<!doctype html><title>Form page</title><body style="font:16px sans-serif">
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent=JSON.stringify(Object.fromEntries(new FormData(this)));">
<label for="name">Your name</label> <input id="name" name="name"><br>
<label>Email <input name="email" type="email" placeholder="you@example.com"></label><br>
<label>Password <input name="pw" type="password"></label><br>
<label for="sel">Color</label> <select id="sel" name="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select><br>
<label><input type="checkbox" name="agree"> I agree</label><br>
<label><input type="radio" name="size" value="s"> Small</label> <label><input type="radio" name="size" value="l"> Large</label><br>
<label>Notes <textarea name="notes"></textarea></label><br>
<div id="rich" contenteditable="true" role="textbox" aria-label="Rich editor" style="border:1px solid #888;min-height:30px"></div>
<button type="submit">Send</button>
</form><pre id="out"></pre>
<input type="file" id="file" aria-label="Upload"><div id="fileout"></div>
<script>document.getElementById('file').onchange=e=>document.getElementById('fileout').textContent=[...e.target.files].map(f=>f.name+':'+f.size).join(',')</script>
</body>`,
  '/search': `<!doctype html><title>Search</title><nav aria-label="Menu">${Array.from({ length: 20 }, (_, i) => `<a href="/popup-target?i=${i}">Menu item ${i}</a>`).join(' ')}</nav><main><form action="/results" method="get"><input name="q" aria-label="Query"><button>Go</button></form></main>`,
  '/results': `<!doctype html><title>Results</title><h1>Results page</h1><p>You searched something</p>`,
  '/article': `<!doctype html><title>Article</title><nav><a href="/">Home</a><a href="/form">Form</a></nav><main><h1>Long read</h1><p>First paragraph with <a href="/form">a link</a> and <b>bold</b> text.<sup class="reference">[1]</sup></p><h2>Part two <span class="editsection">[edit]</span></h2><ul><li>one</li><li>two</li></ul><table><tr><th>Name</th><td>Ada</td></tr><tr><th>Born</th><td>1815</td></tr></table>${Array.from({ length: 80 }, (_, i) => `<p>Filler paragraph number ${i} with enough words to make the page long enough to need paging in text mode.</p>`).join('')}<p>THE END MARKER</p></main><footer>Footer links</footer>`,
  '/popup-target': `<!doctype html><title>Popup target</title><h2>I am the new tab</h2>`,
  '/slow': `<!doctype html><title>Slow</title><h2 id="h">Loading...</h2><script>setTimeout(()=>{document.getElementById('h').textContent='Slow content ready'},700)</script>`,
  '/dialog': `<!doctype html><title>Dialog</title><button onclick="alert('Hello from alert');document.title='after alert'">Alert</button><button onclick="document.title=confirm('Sure?')?'yes':'no'">Confirm</button><button onclick="document.title='prompt:'+prompt('Name?','x')">Prompt</button>`,
  '/shadow': `<!doctype html><title>Shadow</title><div id="host"></div><iframe id="fr" srcdoc="<button onclick=&quot;parent.document.title='iframe click'&quot;>Inside frame</button>" style="width:300px;height:80px"></iframe>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button id=sb>Shadow button</button><input aria-label="Shadow input">';r.getElementById('sb').onclick=()=>document.title='shadow click'</script>`,
  '/dnd': `<!doctype html><title>DnD</title><style>.box{width:120px;height:60px;border:1px solid #888;margin:10px;display:inline-block}</style>
<div id="a" class="box" draggable="true" role="button" aria-label="Drag me">drag</div><div id="b" class="box" aria-label="Drop zone" role="region">zone</div>
<script>const b=document.getElementById('b');b.ondragover=e=>e.preventDefault();b.ondrop=e=>{e.preventDefault();document.title='dropped '+e.dataTransfer.getData('text/plain')};document.getElementById('a').ondragstart=e=>e.dataTransfer.setData('text/plain','payload')</script>`,
  '/ticker': `<!doctype html><title>Ticker</title><body style="font:80px sans-serif"><div id="n">0</div><script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},100)</script>`,
  '/covered': `<!doctype html><title>Covered</title><button onclick="document.title='clicked'">Under cover</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.3)" id="shield"><button onclick="document.getElementById('shield').remove()">Close cover</button></div>`
}
