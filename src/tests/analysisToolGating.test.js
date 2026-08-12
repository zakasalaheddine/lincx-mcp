import test from 'ava'

// constants.js reads NODE_ENV at load, so set it BEFORE importing the tools.
process.env.NODE_ENV = 'production'

const { registerAnalysisTools } = await import('../tools/analysisTools.js')

/** Minimal McpServer stand-in — we only care about which names get registered. */
function collectRegisteredNames () {
  const names = []
  const fake = { registerTool: (name) => { names.push(name) } }
  registerAnalysisTools(fake)
  return names
}

{ // analysis tool registration under NODE_ENV=production
  test('analysis tool registration under NODE_ENV=production > hides create_analysis but keeps the read tools', t => {
    const names = collectRegisteredNames()
    t.false(names.includes('create_analysis'))
    t.true(names.includes('get_analysis'))
    t.true(names.includes('list_analyses'))
  })
}
