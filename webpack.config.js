/* eslint-disable no-undef */

const devCerts = require("office-addin-dev-certs");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const path = require("path");
const http = require("http");
const https = require("https");

const urlDev = "https://localhost:3000/";
const urlProd = "https://www.contoso.com/"; // CHANGE THIS TO YOUR PRODUCTION DEPLOYMENT LOCATION

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

function proxyHandler(req, res) {
  const requestUrl = req.url || "";
  const parsed = new URL(requestUrl, "http://localhost");
  const target = parsed.searchParams.get("url");

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (!target) {
    res.writeHead(400, CORS_HEADERS);
    res.end("Missing url query parameter.");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400, CORS_HEADERS);
    res.end("Invalid url.");
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  if (!headers["accept-encoding"]) {
    headers["accept-encoding"] = "identity";
  }

  const client = targetUrl.protocol === "https:" ? https : http;
  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, { ...proxyRes.headers, ...CORS_HEADERS });
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    res.writeHead(502, CORS_HEADERS);
    res.end(`Proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  const config = {
    devtool: "source-map",
    entry: {
      polyfill: ["core-js/stable", "regenerator-runtime/runtime"],
      react: ["react", "react-dom"],
      taskpane: {
        import: ["./src/taskpane/index.tsx", "./src/taskpane/taskpane.html"],
        dependOn: "react",
      },
      commands: "./src/commands/commands.ts",
    },
    output: {
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".html", ".js", ".mjs"],
      fallback: {
        buffer: require.resolve("buffer/"),
        stream: require.resolve("stream-browserify"),
        util: require.resolve("util/"),
        url: require.resolve("url/"),
        http: require.resolve("stream-http"),
        https: require.resolve("https-browserify"),
        zlib: require.resolve("browserify-zlib"),
        path: require.resolve("path-browserify"),
        os: require.resolve("os-browserify/browser"),
        assert: require.resolve("assert/"),
        events: require.resolve("events/"),
        querystring: require.resolve("querystring-es3"),
        punycode: require.resolve("punycode/"),
        string_decoder: require.resolve("string_decoder/"),
        constants: require.resolve("constants-browserify"),
        vm: require.resolve("vm-browserify"),
        process: require.resolve("process/browser"),
        crypto: require.resolve("./src/shims/crypto-shim.js"),
        fs: false,
        net: false,
        tls: false,
        dns: false,
        child_process: false,
        http2: false,
        worker_threads: false,
        async_hooks: false,
        perf_hooks: false,
      },
      alias: {
        "node:buffer": require.resolve("buffer/"),
        "node:stream": require.resolve("stream-browserify"),
        "node:util": require.resolve("util/"),
        "node:url": require.resolve("url/"),
        "node:http": require.resolve("stream-http"),
        "node:https": require.resolve("https-browserify"),
        "node:zlib": require.resolve("browserify-zlib"),
        "node:path": require.resolve("path-browserify"),
        "node:os": require.resolve("os-browserify/browser"),
        "node:assert": require.resolve("assert/"),
        "node:events": require.resolve("events/"),
        "node:querystring": require.resolve("querystring-es3"),
        "node:punycode": require.resolve("punycode/"),
        "node:string_decoder": require.resolve("string_decoder/"),
        "node:constants": require.resolve("constants-browserify"),
        "node:vm": require.resolve("vm-browserify"),
        "node:process": require.resolve("process/browser"),
        "node:crypto": require.resolve("./src/shims/crypto-shim.js"),
        "node:fs": false,
        "node:net": false,
        "node:tls": false,
        "node:dns": false,
        "node:child_process": false,
        "node:http2": false,
        "node:worker_threads": false,
        "node:async_hooks": false,
        "node:perf_hooks": false,
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
          },
        },
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: ["ts-loader"],
        },
        {
          test: /\.html$/,
          exclude: /node_modules/,
          use: "html-loader",
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
        {
          test: /\.(png|jpg|jpeg|ttf|woff|woff2|gif|ico)$/,
          type: "asset/resource",
          generator: {
            filename: "assets/[name][ext][query]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["polyfill", "taskpane", "react"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "assets/*",
            to: "assets/[name][ext][query]",
          },
          {
            from: "manifest*.xml",
            to: "[name]" + "[ext]",
            transform(content) {
              if (dev) {
                return content;
              } else {
                return content.toString().replace(new RegExp(urlDev, "g"), urlProd);
              }
            },
          },
        ],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["polyfill", "commands"],
      }),
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
      }),
      new webpack.DefinePlugin({
        "process.env": JSON.stringify({}),
        "process.versions": "undefined",
        "process.browser": JSON.stringify(true),
      }),
    ],
    devServer: {
      hot: true,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      setupMiddlewares: (middlewares, devServer) => {
        if (devServer?.app) {
          devServer.app.use("/proxy", proxyHandler);
        }
        return middlewares;
      },
      server: {
        type: "https",
        options:
          env.WEBPACK_BUILD || options.https !== undefined
            ? options.https
            : await getHttpsOptions(),
      },
      port: process.env.npm_package_config_dev_server_port || 3000,
    },
  };

  return config;
};
