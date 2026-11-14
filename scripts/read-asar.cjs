const fs = require('fs')
const file = process.argv[2]
const mode = process.argv[3] || 'paths'
const text = fs.readFileSync(file, 'utf8')

if (mode === 'paths') {
  const found = new Set()
  const re = /["'`](\/[A-Za-z0-9_/{}:.\-]*(?:session|api)[A-Za-z0-9_/{}:.\-]*)["'`]/g
  let m
  while ((m = re.exec(text))) found.add(m[1])
  console.log([...found].slice(0, 60).join('\n'))
} else if (mode === 'grep') {
  const re = new RegExp(process.argv[4])
  const lines = text.split('\n')
  let hits = 0
  for (let i = 0; i < lines.length && hits < 40; i++) {
    if (re.test(lines[i])) {
      console.log(i + 1 + ': ' + lines[i].trim().slice(0, 220))
      hits++
    }
  }
  if (!hits) console.log('(no match)')
} else if (mode === 'size') {
  console.log(text.length)
}
