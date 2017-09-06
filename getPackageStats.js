/**
 * Code heavily inspired from the `import-cost` project
 * @see https://github.com/wix/import-cost/blob/master/packages/import-cost/src/webpack.js
 */

const fs = require("fs")
const path = require("path")
const { gzipSync } = require("zlib")
const debug = require("debug")("bp:worker")
const pify = require('pify')
const autoprefixer = require('autoprefixer')
//
const webpack = require("webpack")
const MemoryFS = require("memory-fs")
const UglifyJSPlugin = require("webpack-parallel-uglify-plugin")
//
const { exec, getExternals, parsePackageString } = require("./utils/server.utils")
const mkdir = require('mkdir-promise')
const config = require('./config')
const CustomError = require("./CustomError")
//const WriteFilePlugin = require('write-file-webpack-plugin')
const ExtractTextPlugin = require("extract-text-webpack-plugin")
const sanitize = require("sanitize-filename")

"use strict"

function getEntryPoint(name) {
  const entryPath = path.join(
    config.tmp,
    "entries",
    sanitize(`index-${name}.js`)
  )

  try {
    fs.writeFileSync(
      entryPath,
      `const p  = require('${name}'); console.log(p)`,
      "utf-8"
    )
    return entryPath
  } catch (err) {
    throw new CustomError("EntryPointError", err)
  }
}

function installPackage(packageName) {
  //const flags = ['ignore-flags', 'skip-integrity-check', 'exact', 'json', 'no-progress', 'silent', 'no-lockfile', 'no-bin-links', 'ignore-optional', 'mutex network']

  const flags = [
    // Setting cache is required for concurrent `npm install`s to work
    `cache=${path.join(config.tmp, "cache")}`,
    "no-package-lock",
    "no-shrinkwrap",
    "no-optional",
    "no-bin-links",
    "prefer-offline",
    "progress false",
    "loglevel error",
    "ignore-scripts",
    "save-exact",
    "fetch-retry-factor 0",
    "fetch-retries 0",
    "json"
  ]

  debug("install start %s", packageName)
  return exec(`npm install ${packageName}`, {
    cwd: config.tmp
  })
    .then(() => {
      debug("install finish %s", packageName)
    })
    .catch(err => {
      throw new CustomError("InstallError", err)
    })
}

function buildPackage(name, externals) {
  const entryPoint = getEntryPoint(name)

  const compiler = webpack({
    entry: entryPoint,
    bail: true,
    //target: "web",
    plugins: [
      new webpack.DefinePlugin({
        "process.env": {
          NODE_ENV: JSON.stringify("production")
        }
      }),
      new webpack.IgnorePlugin(/^electron$/),
      // Removes webpack's bootstrap code so
      // it doesn't get added in a package's size
      new webpack.optimize.CommonsChunkPlugin({
        name: 'commons',
        filename: 'commons.js',
        minChunks: Infinity
      }),
      new webpack.LoaderOptionsPlugin({ minimize: true }),
      new ExtractTextPlugin("bundle.css"),
      //new WriteFilePlugin(),
      new UglifyJSPlugin({
        workerCount: require('os').cpus().length,
        uglifyES: {
          ie8: false
        }
      })
    ],
    resolve: {
      modules: ["node_modules"],
      symlinks: false,
      cacheWithContext: false
    },
    module: {
      noParse: [/\.min\.js/],
      rules: [
        {
          test: /\.css$/,
          use: ExtractTextPlugin.extract({ use: "css-loader" })
        },
        {
          test: /\.(scss|sass)$/,
          loader: ExtractTextPlugin.extract({
            use: [
              'css-loader', {
                loader: 'postcss-loader',
                options: {
                  plugins: () => [
                    autoprefixer({
                      browsers: [
                        "last 5 Chrome versions",
                        "last 5 Firefox versions",
                        "Safari >= 8",
                        "Explorer >= 10",
                        "edge >= 12",
                      ]
                    })
                  ]
                }
              },
              'sass-loader'
            ]
          })
        }
      ]
    },
    node: {
      fs: "empty",
      net: "empty",
      tls: "empty",
      module: "empty",
      child_process: "empty",
      dns: "empty",
      setImmediate: false
    },
    output: {
      filename: "bundle.js"
    },
    externals
  })

  const memoryFileSystem = new MemoryFS()
  compiler.outputFileSystem = memoryFileSystem

  return new Promise((resolve, reject) => {
    debug("build start %s", name)
    compiler.run((err, stats) => {
      debug("build end %s", name)

      fs.unlinkSync(entryPoint)

      // stats object can be empty if there are build errors
      let jsonStats = stats ? stats.toJson() : {}
      if ((err && err.details) && !stats) {
        reject(new CustomError("BuildError", err.details))
      } else if (jsonStats.errors && (jsonStats.errors.length > 0)) {
        reject(new CustomError("BuildError", stats.toJson().errors))
      } else {
        const isCSSAsset = jsonStats.assets.some(
          asset => asset.name.endsWith('.css'))
        const bundleName = isCSSAsset ? 'bundle.css' : 'bundle.js'
        const size = jsonStats.assets
          .filter(x => x.name === bundleName)
          .pop()
          .size

        const bundle = path.join(process.cwd(), bundleName)
        const gzip = gzipSync(memoryFileSystem.readFileSync(bundle), {}).length

        debug("build result %O", { size, gzip })
        resolve({ size, gzip })
      }
    })
  })
}

function getPackageJSONDetails(packageName) {
  const packageJSONPath = path.join(config.tmp, 'node_modules', packageName, 'package.json')
  return pify(fs.readFile)(packageJSONPath, 'utf8')
    .then(contents => {
      const parsedJSON = JSON.parse(contents)
      return {
        dependencyCount: 'dependencies' in parsedJSON ?
          Object.keys(parsedJSON.dependencies).length : 0,
        hasJSNext: parsedJSON['jsnext:main'] || false,
        hasJSModule: parsedJSON['module'] || false,
        peerDependencies: 'peerDependencies' in parsedJSON ?
          Object.keys(parsedJSON.peerDependencies) : []
      }
    })
}

function getPackageStats(packageString) {
  const packageName = parsePackageString(packageString).name

  return mkdir(config.tmp)
    .then(() => mkdir(path.join(config.tmp, "entries")))
    .then(() => {
      fs.writeFileSync(
        path.join(config.tmp, "package.json"),
        JSON.stringify({ dependencies: {} })
      )

      return installPackage(packageString)
    })
    .then(() => {
      const externals = getExternals(packageName)
      return Promise.all([
        getPackageJSONDetails(packageName),
        buildPackage(packageName, externals)
      ])
    })
    .then(([pacakgeJSONDetails, builtDetails]) => {
      return Object.assign({}, pacakgeJSONDetails, builtDetails)
    })
}

module.exports = getPackageStats