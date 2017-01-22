import path = require('path')
import normalizePath = require('normalize-path')
import linkDir from 'link-dir'
import fs = require('mz/fs')
import mkdirp from '../fs/mkdirp'
import requireJson from '../fs/requireJson'
import getPkgDirs from '../fs/getPkgDirs'
import binify from '../binify'
import isWindows = require('is-windows')
import cmdShim = require('@zkochan/cmd-shim')
import {Package} from '../types'
import logger from 'pnpm-logger'
import os = require('os')
import {PnpmBinRunnerOptions} from 'pnpm-bin-runner'

export type BinOptions = {
  global: boolean,
}

const IS_WINDOWS = isWindows()

export default async function linkAllBins (modules: string, binPath: string, opts: BinOptions) {
  const pkgDirs = await getPkgDirs(modules)
  return Promise.all(pkgDirs.map((pkgDir: string) => linkPkgBins(pkgDir, binPath, opts)))
}

/**
 * Links executable into `node_modules/.bin`.
 */
export async function linkPkgBins (target: string, binPath: string, opts: BinOptions) {
  const pkg = await safeRequireJson(path.join(target, 'package.json'))
  const targetRealPath = await fs.realpath(target)
  const extraNodePath = [path.join(targetRealPath, 'node_modules'), path.join(targetRealPath, '..', 'node_modules')]

  if (!pkg) {
    logger.warn(`There's a directory in node_modules without package.json: ${target}`)
    return
  }

  if (!pkg.bin) return

  const bins = binify(pkg)

  await mkdirp(binPath)
  await Promise.all(Object.keys(bins).map(bin => linkBin(target, bin, bins[bin], binPath, pkg.name, extraNodePath, opts)))
}

async function linkBin (
  target: string,
  bin: string,
  actualBin: string,
  binPath: string,
  pkgName: string,
  extraNodePath: string[],
  opts: BinOptions
) {
  const externalBinPath = path.join(binPath, bin)
  const targetPath = path.join(target, actualBin)
  const relativeRequirePath = await getBinRequirePath(binPath, targetPath)
  const cmdOpts = {
    nodePath: extraNodePath.concat(getNodePaths(targetPath)).join(path.delimiter),
  }

  if (opts.global) {
    const runnerFilePath = path.join(binPath, `${bin}.runner.js`)
    const binRunnerOptions: PnpmBinRunnerOptions = {
      requiredBin: path.join(pkgName, actualBin),
      globalRequirePath: targetPath,
      bin,
    }
    const binRunnerRequirePath = await getBinRequirePath(binPath, require.resolve('pnpm-bin-runner'))
    await fs.writeFile(runnerFilePath, '#!/usr/bin/env node' +
      os.EOL + `require('${binRunnerRequirePath}').default(${JSON.stringify(binRunnerOptions)})`, 'utf8')
    return cmdShim(runnerFilePath, externalBinPath, cmdOpts)
  }

  return cmdShim(targetPath, externalBinPath, cmdOpts)
}

async function getBinRequirePath (binPath: string, targetPath: string) {
  const realBinPath = await fs.realpath(binPath)
  const relTargetPath = normalizePath(path.relative(realBinPath, targetPath))
  if (!relTargetPath.startsWith('.')) {
    // require should always be identified as relative by Node
    return `./${relTargetPath}`
  }
  return relTargetPath
}

function getNodePaths (filename: string): string[] {
  const next = path.join(filename, '..')
  const modules = path.join(filename, 'node_modules')
  if (filename === next) return [modules]
  return [modules].concat(getNodePaths(next))
}

/**
 * Like `require()`, but returns `null` when it is not found
 */
function safeRequireJson (pkgJsonPath: string): Package | null {
  try {
    return requireJson(pkgJsonPath)
  } catch (err) {
    if ((<NodeJS.ErrnoException>err).code !== 'ENOENT') throw err
    return null
  }
}
