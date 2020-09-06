const path = require('path')
const dotenv = require('dotenv')
const CopyPlugin = require('copy-webpack-plugin')
const JsonPostProcessPlugin = require('json-post-process-webpack-plugin')
const packageJSON = require('./package.json')

dotenv.config()

/**
 * @param {string} str
 */
const pluginSource = (str) => path.join(__dirname, `src/plugin/${str}`)

/**
 * @param {string} str
 */
const pluginDist = (str) => path.join(__dirname, `dist/plugin/${str}`)

module.exports = {
  mode: process.env.MODE,
  devtool: 'inline-source-map',
  entry: {
    contentScript: pluginSource`contentScript.ts`,
    backgroundScript: pluginSource`backgroundScript.ts`,
  },
  output: {
    path: pluginDist``,
    filename: '[name].js',
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  plugins: [
    new JsonPostProcessPlugin({
      matchers: [
        {
          matcher: /manifest\.json$/,
          action: (currentJSON) => ({ ...currentJSON, version: packageJSON.version }),
        },
      ],
    }),
    new CopyPlugin({
      patterns: [{ from: pluginSource`public`, to: pluginDist`` }],
      options: {},
    }),
  ],
}
