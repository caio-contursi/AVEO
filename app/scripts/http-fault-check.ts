import { runFaultAcceptance } from './fault-check'

runFaultAcceptance('http-loopback').catch(() => {
  console.error('FAIL http-fault-check: could not finish the local report')
  process.exitCode = 1
})
