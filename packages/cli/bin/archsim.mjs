#!/usr/bin/env node
// archsim — the headless engine.
//
// Node 20+, zero dependencies, no build step: it has to run on an airgapped
// runner where `npm install` is a change-control ticket.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/main.js'

const argv = process.argv.slice(2)
main(argv, { fs, path, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr })
  .then((code) => { process.exitCode = code })
  .catch((err) => {
    process.stderr.write(`archsim: ${err?.message || err}\n`)
    if (process.env.ARCHSIM_DEBUG) process.stderr.write(`${err?.stack}\n`)
    process.exitCode = 3
  })

export { fileURLToPath }
