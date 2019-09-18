const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();
const AsciiTable = require("ascii-table");
const MarkdownTable = require("markdown-table");

const SEARCH_TERM = "SEARCH";
const { UBI_EMAIL, UBI_PASSWORD, UBI_ID } = process.env;

(async () => {
  // scraped information
  let manifests = [];
  let apiRequests = [];
  let version = "unknown";
  const toDownload = [];

  fs.removeSync("./log");
  fs.mkdirSync("./log");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.setRequestInterception(true);
  page.on("response", async response => {
    const request = response.request();
    const url = request.url();
    if (
      request.resourceType() === "xhr" &&
      request.method !== "OPTIONS" &&
      url.startsWith("https://public-ubiservices.ubi.com")
    ) {
      console.log(`Identified API request ${url}.`);
      const json = await response.json();
      apiRequests.push({
        url,
        headers: mapObject(request.headers(), (value, header) =>
          header === "authorization"
            ? value.replace(/=([A-Za-z0-9-._]+)/, "={AUTH_TOKEN}")
            : value
        ),
        response: json,
        responseHeaders: response.headers()
      });
    }
  });
  page.on("request", request => {
    const url = request.url();
    if (request.resourceType() === "xhr") {
      if (url.endsWith(".json")) {
        // save json files
        console.log(`Added ${url} to manifest list.`);
        manifests.push(url);
      }
    }
    request.continue();
  });
  const startUrl = "https://game-rainbow6.ubi.com/en-us/home";

  await page.goto(startUrl);
  await page.screenshot({ path: "log/startup.png", fullPage: true });

  await sleep(5e2);

  await waitFor(page, () => {
    return (
      Array.from(document.getElementsByTagName("button")).filter(
        el => el.innerText === "LOG IN"
      )[0] !== undefined
    );
  });
  // get the version (not a very reliable method, OK if it doesn't work)
  version = await page.evaluate(() => {
    const footer = document
      .querySelector("div.footer-legal.rs-atom-box")
      .innerText.split("\n");
    return footer[footer.length - 1];
  });
  version && console.log(`Identified version as ${version}`);
  await page.evaluate(() => {
    Array.from(document.getElementsByTagName("button"))
      .filter(el => el.innerText === "LOG IN")[0]
      .click();
  });
  await page.screenshot({ path: "log/login_popup.png", fullPage: true });

  // wait for load
  await waitFor(page, () => {
    return document.getElementsByTagName("button")["LogInButton"] !== undefined;
  });
  await sleep(1e3); // give the frame time to load and animate in
  await page.screenshot({ path: "log/login.png", fullPage: true });

  const embedded_frames = await page.frames();
  const login_frame = embedded_frames.filter(frame =>
    frame.url().startsWith("https://connect.ubi.com/?")
  )[0];

  // login
  await login_frame.evaluate(
    ({ UBI_EMAIL, UBI_PASSWORD }) => {
      let inputs = document.getElementsByTagName("input");
      inputs["AuthEmail"].value = UBI_EMAIL;
      inputs["AuthPassword"].value = UBI_PASSWORD;
      inputs["RememberMe"].checked = true;

      let buttons = document.getElementsByTagName("button");
      buttons["LogInButton"].click();
    },
    { UBI_EMAIL, UBI_PASSWORD }
  );

  await page.waitForNavigation({ timeout: 1e5, waitUntil: "load" });
  await page.screenshot({ path: "log/stats.png", fullPage: true });

  // search for SEARCH_TERM to record API response
  await page.evaluate(() => {
    document
      .getElementsByClassName("search")[0]
      .getElementsByTagName("a")[0]
      .click();
  });
  await page.screenshot({ path: "log/search-popup.png", fullPage: true });

  await page.evaluate(SEARCH_TERM => {
    const field = document.getElementsByTagName("input")[0];
    field.value = SEARCH_TERM;
    field.dispatchEvent(new InputEvent("input"));
  }, SEARCH_TERM);
  // wait for the request to get through
  await sleep(5e3);

  await browser.close();

  // setup a directory for unorganized files
  const downloads = `./downloads/${version}`;
  try {
    fs.mkdirSync("./downloads");
  } catch (e) {
    // not the first scrape, make sure nothing exists for this version
    fs.removeSync(`${downloads}`);
  }
  fs.mkdirSync(`${downloads}`);
  // download the manifests
  await Promise.all(manifests.map(download(downloads)));

  // there should be operators, ranks, seasons, weapons, and locale manifests
  const manifestPaths = manifests.reduce((paths, file) => {
    file = cleanUrl(file);
    const manifest = file.match(
      /___([a-z]+).(?:[a-z-]+.)?(?:[a-z0-9]+).([a-z]+)$/
    )[1];
    paths[manifest] = `${downloads}/${file}`;
    return paths;
  }, {});

  // load in the manifests
  const manifestContent = mapObject(manifestPaths, path => {
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  });

  // localize
  const localized = mapObject(
    manifestContent,
    localize(manifestContent.locale)
  );

  // combine the localized manifests into the final manifest file
  let manifest = {};
  // get operators as array
  const inDisplayOrder = unKey(localized.operators).sort(
    (op1, op2) => getDisplayPosition(op1) - getDisplayPosition(op2)
  );
  // sort them by display order
  manifest.allOperators = inDisplayOrder.map(op => op.id);
  // filter to get attackers and defenders
  manifest.attackers = inDisplayOrder
    .filter(op => op.category === "atk")
    .map(op => op.id);
  manifest.defenders = inDisplayOrder
    .filter(op => op.category === "def")
    .map(op => op.id);
  // trim unwanted fields on operators
  manifest.operators = mapObject(localized.operators, op => {
    const {
      category,
      name,
      id,
      ctu: unit,
      uniqueStatistic: {
        pvp: { statisticId: statId, label: statLabel }
      },
      mask,
      badge,
      figure: { large, small }
    } = op;
    // add the assets to the download list
    toDownload.push({
      url: large,
      local: `operators/${op.id}/large.png`
    });
    toDownload.push({
      url: small,
      local: `operators/${op.id}/small.png`
    });
    toDownload.push({
      url: mask,
      local: `operators/${op.id}/mask.png`
    });
    toDownload.push({
      url: badge,
      local: `operators/${op.id}/icon.png`
    });
    return {
      category: category === "atk" ? "attack" : "defend",
      name,
      unit,
      statId,
      statLabel,
      small: `operators/${op.id}/small.png`,
      large: `operators/${op.id}/large.png`,
      mask: `operators/${op.id}/mask.png`,
      icon: `operators/${op.id}/icon.png`
    };
  });
  // get seasons
  manifest.allSeasons = Object.keys(localized.seasons.seasons).map(
    s => `s${s}`
  );
  manifest.currentSeason = localized.seasons.latestSeason;
  manifest.seasons = reKey(
    mapObject(localized.seasons.seasons, (season, id) => {
      toDownload.push({
        url: season.background,
        local: `seasons/s${id}/background.jpg`
      });
      return {
        name: season.name,
        background: `seasons/s${id}/background.jpg`
      };
    }),
    id => `s${id}`
  );
  // get the divisions and ranks for each season
  manifest.divisions = {};
  manifest.ranks = {};
  for (const key in localized.ranks.seasons) {
    const season = localized.ranks.seasons[key];
    manifest.seasons[`s${season.id}`].divisions = Object.keys(
      season.divisions
    ).map(d => `s${season.id}-d${d}`);
    manifest.divisions = manifest.divisions || {};
    manifest.ranks = manifest.ranks || {};
    for (const id in season.divisions) {
      const division = season.divisions[id];
      const { name, ranks } = division;
      manifest.divisions[`s${season.id}-d${id}`] = {
        name,
        ranks: Object.keys(ranks).map(r => `s${season.id}-r${r}`)
      };
    }
    for (const id in season.ranks) {
      const rank = season.ranks[id];
      let { name, range, images } = rank;
      toDownload.push({
        url: images.hd || images.default,
        local: `seasons/s${season.id}/ranks/r${id}/icon.svg`
      });
      range = range || { "0": 0, "1": 0 };
      const { "0": min, "1": max } = range;
      manifest.ranks[`s${season.id}-r${id}`] = {
        name,
        min,
        max,
        icon: `seasons/s${season.id}/ranks/r${id}/icon.svg`
      };
    }
  }
  manifest.allRanks = Object.keys(manifest.ranks);
  manifest.allDivisions = Object.keys(manifest.divisions);
  fs.removeSync("./dist");
  fs.mkdirSync("./dist");
  fs.writeFileSync("./dist/manifest.json", JSON.stringify(manifest));
  fs.removeSync("./dist/assets");
  fs.mkdirSync("./dist/assets");
  // download all the assets
  await batch(
    toDownload,
    downloadAs({
      localPath: "./dist/assets",
      baseUrl: "https://game-rainbow6.ubi.com"
    }),
    50
  );
  console.log(`Downloaded ${toDownload.length} items.`);

  fs.mkdirpSync('./docs/auto');

  // auto gen docs for the manifest
  // operators
  fs.writeFileSync(
    "./docs/auto/operators.md",
    [
      "---\nid: operators\ntitle: Operators\nsidebar_label: Operators\n---\n\n This page is automatically generated during the scraping process.",
      manifest.allOperators
        .map(id => {
          const operator = manifest.operators[id];
          return [
            `## ${operator.name}`,
            `\`\`\`json\n${JSON.stringify(operator, null, 2)}\n\`\`\``,
            `#### Large`,
            `![${operator.name}](/img/assets/${operator.large} "large.png")`,
            `#### Small`,
            `![${operator.name}](/img/assets/${operator.small} "small.png")`,
            `#### Mask`,
            `![${operator.name} mask](/img/assets/${operator.mask} "mask.png")`,
            `#### Icon`,
            `![${operator.name} icon](/img/assets/${operator.icon} "icon.png")`
          ].join("\n");
        })
        .join("\n\n")
    ].join("\n")
  );
  // seasons
  fs.writeFileSync(
    "./docs/auto/seasons.md",
    [
      "---\nid: seasons\ntitle: Seasons\nsidebar_label: Seasons\n---\n\n This page is automatically generated during the scraping process.",
      manifest.allSeasons
        .map(id => {
          const season = manifest.seasons[id];
          return [
            `## ${season.name}`,
            `\`\`\`json\n${JSON.stringify(season, null, 2)}\n\`\`\``,
            `#### Background`,
            `![${season.name}](/img/assets/${season.background} "background.jpg")`
          ].join("\n");
        })
        .join("\n\n")
    ].join("\n")
  );
  // divisions
  fs.writeFileSync(
    "./docs/auto/divisions.md",
    [
      "---\nid: divisions\ntitle: Divisions\nsidebar_label: Divisions\n---\n\n This page is automatically generated during the scraping process.",
      manifest.allDivisions
        .map((id, index) => {
          const division = manifest.divisions[id];
          const season = id.match(/s([0-9]+)-/)[1];
          const prefix =
            index === 0 ||
            season !=
              manifest.allDivisions[index - 1].match(
                /s([0-9]+)-/
              )[1]
              ? [`## Season ${season}`]
              : [];
          return prefix
            .concat([
              `### ${division.name}`,
              `### ${id}`,
              `\`\`\`json\n${JSON.stringify(division, null, 2)}\n\`\`\``
            ])
            .join("\n");
        })
        .join("\n\n")
    ].join("\n")
  );
  // ranks
  fs.writeFileSync(
    "./docs/auto/ranks.md",
    [
      "---\nid: ranks\ntitle: Ranks\nsidebar_label: Ranks\n---\n\n This page is automatically generated during the scraping process.",
      manifest.allRanks
        .map( (id, index) => {
          const rank = manifest.ranks[id];
          const season = id.match(/s([0-9]+)-/)[1];
          const prefix =
            index === 0 ||
            season !=
              manifest.allRanks[index - 1].match(
                /s([0-9]+)-/
              )[1]
              ? [`## Season ${season}`]
              : [];
          return prefix
            .concat([
              `### ${rank.name}`,
              `### ${id}`,
              `\`\`\`json\n${JSON.stringify(rank, null, 2)}\n\`\`\``,
              `#### Icon`,
              `![${rank.name}](/img/assets/${rank.icon} "icon.svg")`
            ])
            .join("\n");
        })
        .join("\n\n")
    ].join("\n")
  );

  // copy dist into website/static/img
  fs.copySync("./dist", "./website/static/img");

  // organize the intercepted requests to be easier to read
  apiRequests = unique(apiRequests)
    .map(({ url, ...rest }) => {
      return {
        ...rest,
        url: replace(replace(url, UBI_ID, "{PROFILE_ID}"), SEARCH_TERM)
      };
    })
    .map(({ url, headers, response, responseHeaders }) => {
      const [scheme, rest] = url.split("://");
      const components = rest.split("/");
      const [host, version, ...end] = components;
      let [endpoint, queryString] = end.join("/").split("?") || "";
      return {
        url,
        scheme,
        host,
        version: parseInt(version[1]),
        endpoint,
        query: queryString
          ? queryString.split("&").reduce((query, piece) => {
              const [key, value] = piece.split("=") || "";
              const values = value.split(",");
              const parsed = values.length === 1 ? values[0] : values;
              query[key] = parsed;
              return query;
            }, {})
          : undefined,
        headers,
        response,
        responseHeaders
      };
    })
    .sort((r1, r2) => {
      // sort first by version number
      const v = r1.version - r2.version;
      if (v === 0) {
        // sort by endpoint alphabetically so they'll be grouped
        if (r1.endpoint === r2.endpoint) {
          return 0;
        } else {
          return r1.endpoint > r2.endpoint ? -1 : 1;
        }
      } else {
        return v;
      }
    });
  const asJson = apiRequests.map(r => {
    const { url, ...rest } = r;
    return JSON.stringify(rest);
  });

  const requests = table({
    title: "Request Details",
    heading: [
      "#",
      "Version",
      "Endpoint",
      "Query String Parameters",
      "Scheme",
      "Host",
      "URL"
    ],
    rows: apiRequests.map((r, index) => [
      index,
      r.version,
      r.endpoint,
      r.query ? Object.keys(r.query).join(",") : "",
      r.scheme,
      r.host,
      limit(r.url, 100)
    ])
  });

  const detailed = apiRequests.map((r, index) => [
    { ascii: `Request #${index}:`, md: `## Request #${index}` },
    table({
      title: "Request",
      heading: ["Host", "Version", "Endpoint"],
      rows: [[r.host, r.version, r.endpoint]]
    }),
    table({
      title: "Query String",
      heading: ["Parameter", "Value"],
      rows: r.query
        ? Object.keys(r.query).map(param => [param, r.query[param]])
        : [["", ""]]
    }),
    table({
      title: "Request Headers",
      heading: ["Header", "Value"],
      rows: r.headers
        ? Object.keys(r.headers).map(param => [param, r.headers[param]])
        : ["", ""]
    }),
    table({
      title: "Response Headers",
      heading: ["Header", "Value"],
      rows: r.responseHeaders
        ? Object.keys(r.responseHeaders).map(param => [
            param,
            r.responseHeaders[param]
          ])
        : ["", ""]
    }),
    r.response
      ? {
          ascii: `Response: \n${JSON.stringify(r.response, null, 2)}`,
          md: `### Response \n\`\`\`json\n${JSON.stringify(
            r.response,
            null,
            2
          )}\n\`\`\``
        }
      : { ascii: "Error: no response", md: "Error: no response" }
  ]);

  try {
    fs.mkdirSync("./docs");
  } catch (e) {}

  fs.writeFileSync(
    "./docs/auto/requests.txt",
    ["API Format", requests.ascii, detailed.map(getAscii).join("\n\n")].join(
      "\n\n"
    )
  );
  fs.writeFileSync(
    "./docs/auto/requests.md",
    [
      "---\nid: requests\ntitle: Sample API Requests\nsidebar_label: Sample Requests\n---",
      "# API Format\nThis page is generated automatically by the API scraper.",
      requests.md,
      detailed.map(getMarkdown).join("\n\n")
    ].join("\n\n")
  );
  fs.writeFileSync("./log/requests", apiRequests.map(r => r.url).join("\n"));
  console.log(`Recorded API requests.`);
})();

// on unhandled rejections, exit so that another attempt can be made
process.on("unhandledRejection", e => {
  console.log(e);
  process.exit(1);
});

// table that supports markdown and ascii exports
const table = ({ title, heading, rows }) => {
  return {
    ascii: AsciiTable.factory({ title, heading, rows }).toString(),
    md: [`### ${title} `, MarkdownTable([heading].concat(rows))].join("\n\n")
  };
};

// get the markdown version of detailed
const getMarkdown = requestDetails => {
  return requestDetails.map(t => t.md).join("\n");
};

// get the ascii version of detailed
const getAscii = requestDetails => {
  return requestDetails.map(t => t.ascii).join("\n");
};

// update the api request object to include response json and headers
const addApiResponse = async o => {
  const { url, headers } = o;
  const res = await fetch(url, new fetch.Headers(headers));
  const response = await res.json();
  const responseHeaders = res.headers;

  console.log({
    ...o,
    response,
    responseHeaders
  });

  return {
    ...o,
    response,
    responseHeaders
  };
};

// download and save the content of a url
const download = downloads => async url => {
  const res = await fetch(url);
  const name = cleanUrl(url);
  const file = fs.createWriteStream(`${downloads}/${name}`);
  return new Promise((resolve, reject) => {
    res.body.pipe(file);
    // add a timeout
    const timeout = setTimeout(() => {
      console.log(`Attempt to download ${url} timed out after 10s.`);
      reject();
    }, 1e4);
    res.body.on("error", err => {
      console.error(err);
      console.log(`Unable to download ${url}.`);
      clearTimeout(timeout);
      reject();
    });
    file.on("finish", () => {
      console.log(`Finished downloading ${url}.`);
      clearTimeout(timeout);
      resolve();
    });
  });
};

const batch = async (arr, f, n) => {
  let batches = [];
  const count = Math.max(arr.length / n);
  for (let i = 0; i < count; i++) {
    batches.push(arr.slice(i * n, (i + 1) * n));
  }
  for (let j = 0; j < batches.length; j++) {
    console.log(`Beginning request batch ${j + 1}.`);
    await Promise.all(batches[j].map(f));
    console.log(`Completed request batch ${j + 1}.`);
  }
};

const downloadAs = ({ localPath, baseUrl }) => {
  count = 0;
  return async ({ url, local }) => {
    url = `${baseUrl}/${url}`;
    local = `${localPath}/${local}`;
    const res = await fetch(url);
    // ensure the path exists
    fs.mkdirpSync(path.parse(local).dir);
    const file = fs.createWriteStream(local);
    return new Promise(resolve => {
      res.body.pipe(file);
      res.body.on("error", err => {
        console.error(err);
        console.log(`Unable to download ${url}.`);
        resolve();
      });
      file.on("finish", () => {
        count++;
        console.log(`Finished downloading ${url}. [#${count}]`);
        resolve();
      });
    });
  };
};

// replace all objects of the form { "oasisId": id } with translate[id]
const localize = translate => (obj, manifest) => {
  if (manifest === "locale") {
    return undefined;
  }
  const r = {};
  for (const key in obj) {
    r[key] = _localize(obj[key], translate);
  }
  return r;
};

const _localize = (obj, translate) => {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (obj.oasisId) {
    return translate[obj.oasisId];
  }
  const r = {};
  for (const key in obj) {
    r[key] = _localize(obj[key], translate);
  }
  return r;
};

// get the display position based on operator id
const getDisplayPosition = op => {
  return parseInt(
    op.index
      .split(":")
      .reverse()
      .join(""),
    16
  );
};

// make a url a valid filename
const cleanUrl = url =>
  url.replace(/([\/])/g, "___").replace(/([\\<>:"|?*])/g, "");

// limit the length of a string
const limit = (str, n) => {
  return str.length > n ? str.slice(0, n - 4) + "..." : str;
};

// keep a value in a closure
const keepLast = f => {
  let last;
  return f;
};

// replace all instances of a substring
const replace = (str, match, replace = "") => {
  return str.split(match).join(replace);
};

// de dupe an array
const unique = array => {
  return array.filter((v, index) => array.indexOf(v) === index);
};

// array.map but for objects
const mapObject = (obj, f) => {
  let r = {};
  for (const key in obj) {
    const val = f(obj[key], key);
    val && (r[key] = val);
  }
  return r;
};

// change the keys on an object
const reKey = (obj, f) => {
  let r = {};
  for (const key in obj) {
    r[f(key, obj[key])] = obj[key];
  }
  return r;
};

// turn a keyed object into an array
const unKey = obj => {
  return Object.keys(obj).map(key => obj[key]);
};

// async sleep
const sleep = delay => {
  return new Promise(resolve => {
    setTimeout(resolve, delay);
  });
};

// wait for the condition to evaluate to true
const waitFor = async (page, condition) => {
  let retry = 1;
  const attempt = async () => {
    return new Promise(async resolve => {
      const passed = await page.evaluate(condition);
      if (passed) {
        resolve(true);
      } else {
        retry *= 2;
        sleep(retry);
        resolve(attempt);
      }
    });
  };
};

/* final result:
 *
 * manifests.json: a consolidated manifest file
 * to order operators reverse the index, remove : and read as hex, then sort
 * sX-(d|r)Y format for season, division and rank identifiers
 * schema:
 * {
 *    allOperators: string[],
 *    attackers: string[],
 *    defenders: string[],
 *    operators: {
 *      [operatorId: string]: {
 *        category: attack|defend,
 *        name: string,
 *        unit: string,
 *        statId: string,
 *        statLabel: string,
 *      }
 *    },
 *    allSeasons: string[],
 *    currentSeason: string,
 *    seasons: {
 *      [season: string]: {
 *        name: string,
 *        divisions: string[]
 *      }
 *    },
 *    divisions: {
 *      [division: string]: {
 *        name: string,
 *        ranks: string[]
 *      }
 *    },
 *    ranks: {
 *      [rank: string]: {
 *        name: string,
 *        min: number,
 *        max: number,
 *      }
 *    }
 * }
 *
 * api report format
 * API Format
 * ------------------------------------
 * List of requests
 * ------------------------------------
 * Table for requests broken (detailed)
 * ------------------------------------
 * (for each request)
 * Table with request info
 *
 *
 * file structure
 * manifest.json
 * api
 * operators/{id}
 *    -large.png
 *    -small.png
 *    -mask.png
 *    -badge.png
 * seasons/{id}
 *    -background.jpg
 *    -/ranks/${id}
 *        -icon.svg
 *
 */
