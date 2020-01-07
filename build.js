var puppeteer = require('puppeteer')
const fs = require("fs-extra");
const path = require("path");
const fetch = require("node-fetch");
require("dotenv").config();
const AsciiTable = require("ascii-table");
const MarkdownTable = require("markdown-table");

const SEARCH_TERM = "SEARCH";
const { UBI_EMAIL, UBI_PASSWORD, UBI_ID, DEBUG } = process.env;

const debug = DEBUG ? m => console.log(`DEBUG: ${m}`) : () => {};

(async () => {
  // scraped information
  let manifests = [];
  let apiRequests = [];
  let version = "unknown";
  const toDownload = [];

  debug("cleaning up old log files");
  fs.removeSync("./log");
  fs.mkdirSync("./log");


  var options = { headless: process.env.CI || process.env.NETLIFY || !DEBUG,  args: [
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox'
  ] };
  
  debug("launching browser");
  const browser = await puppeteer.launch(options);
  const page = await browser.newPage();

  debug("adding request interception");
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
            ? (!value.startsWith("Basic")
              ? value.replace(/=([A-Za-z0-9-._]+)/, "={AUTH_TOKEN}")
              : "Basic {AUTH_TOKEN}")
            : value
        ),
        response: json,
        responseHeaders: response.headers()
      });
    } else if (request.resourceType() === "image") {
      debug(`Loaded ${url}`);
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
  debug(`opening ${startUrl}`);
  await page.goto(startUrl);

  await sleep(5e2);

  await waitFor(page, () => {
    return (
      Array.from(document.getElementsByTagName("button")).filter(
        el => el.innerText === "LOG IN"
      )[0] !== undefined
    );
  });

  debug("checking site version");
  // get the version (not a very reliable method, OK if it doesn't work)
  version = await page.evaluate(() => {
    const footer = document
      .querySelector("div.footer-legal.rs-atom-box")
      .innerText.split("\n");
    return footer[footer.length - 1];
  });
  version && console.log(`Identified version as ${version}`);

  debug("starting login");
  await page.evaluate(() => {
    Array.from(document.getElementsByTagName("button"))
      .filter(el => el.innerText === "LOG IN")[0]
      .click();
  });

  // wait for load
  await waitFor(page, () => {
    return document.getElementsByTagName("button")["LogInButton"] !== undefined;
  });
  await sleep(5e3); // give the frame time to load and animate in

  const embedded_frames = await page.frames();
  const login_frame = embedded_frames.filter(frame =>
    frame.url().startsWith("https://connect.ubisoft.com/login")
  )[0];

  await waitFor(login_frame, () => {
    return (
      Array.from(document.getElementsByTagName("button")).filter(
        el => el.innerText === "LOG IN"
      )[0] !== undefined
    );
  });

  // login
  debug("entering credentials");
  await login_frame.evaluate(
    ({ UBI_EMAIL, UBI_PASSWORD }) => {
      let inputs = document.getElementsByTagName("input");
      inputs["AuthEmail"].value = UBI_EMAIL;
      inputs["AuthPassword"].value = UBI_PASSWORD;
      inputs["RememberMe"].checked = true;

      // need to touch the inputs so that they update the UI framework
      let touch = new Event('input');
      inputs["AuthEmail"].dispatchEvent(touch);
      inputs["AuthPassword"].dispatchEvent(touch);

      let buttons = document.getElementsByTagName("button");
      Array.from(buttons).filter(el => el.innerText === "LOG IN")[0].click();
    },
    { UBI_EMAIL, UBI_PASSWORD }
  );

  debug("waiting for stats to load");
  await page.waitForNavigation({ timeout: 3e5, waitUntil: "load" });

  // search for SEARCH_TERM to record API response
  debug("capturing search request");
  await page.evaluate(() => {
    document
      .getElementsByClassName("search")[0]
      .getElementsByTagName("a")[0]
      .click();
  });

  await page.evaluate(SEARCH_TERM => {
    const field = document.getElementsByTagName("input")[0];
    field.value = SEARCH_TERM;
    field.dispatchEvent(new InputEvent("input"));
  }, SEARCH_TERM);
  // wait for the request to get through
  await sleep(5e3);

  // load in the manifests
  debug("building manifest");
  const manifestContent = await reduceToObjectAsync(manifests, async path => {
    const u = path.split("/");
    return [
      u[u.length - 1].split(".")[0],
      await fetch(path).then(res => res.json())
    ];
  });

  // localize
  debug("localizing manifest");
  const localized = mapObject(
    manifestContent,
    localize(manifestContent.locale)
  );

  // combine the localized manifests into the final manifest file
  let manifest = {};
  // lookup id by name (needed for when scraping gets messier)
  let nameToId = {};
  for (const key in localized.operators) {
    nameToId[localized.operators[key].name.toLowerCase()] = key;
  }

  // for scraping rainbow6.ubisoft.com it's a bit more complex, there's no JSON files to work with
  // and different pages follow different formats

  // start with Ash as a known operator
  debug("scraping operator bio pages")
  await page.goto(
    "https://rainbow6.ubisoft.com/siege/en-us/game-info/operators/ash/index.aspx"
  );

  // get a list of more urls from the bottom nav
  const operatorsPages = await page.evaluate(() => {
    const operators = Array.from(
      document.querySelectorAll(
        ".operator-browser .operator-section-content li a"
      )
    );
    return operators.map(el => el.href);
  });

  // **/index_old redirects to **/index, but the _old tells us a bit about the page layout
  // There are 3 different layouts
  // Type 1: role, flag, name, icon, unit, armor, speed, difficulty, video, weapons, bio info, (sometimes tips & interactions)
  // Type 2: flag, name, icon, unit, armor, speed, bio, gadget
  // Type 3: Type 1
  // Type 4: Type 3 but with sliders for loadout

  const extraOperatorInfo = await reduceToObjectAsync(
    operatorsPages,
    async url => {
      await page.goto(url);

      console.log(`Scraping ${url}`);

      return await page.evaluate(
        operatorLayouts[await page.evaluate(determineOperatorLayout)],
        nameToId
      );
    }
  );

  fs.writeFileSync("./temp", JSON.stringify(extraOperatorInfo));
  debug("closing browser");
  await browser.close();

  // get operators as array
  debug("cleaning up manifest");
  const inDisplayOrder = unKey(localized.operators).sort(
    (op1, op2) => getDisplayPosition(op1) - getDisplayPosition(op2)
  );
  // sort them by display order
  manifest.allOperators = inDisplayOrder.map(op => op.id);
  // filter to get attackers and defenders
  manifest.attackers = inDisplayOrder
    .filter(op => op.category === "attacker")
    .map(op => op.id);
  manifest.defenders = inDisplayOrder
    .filter(op => op.category === "defender")
    .map(op => op.id);
  // trim unwanted fields on operators
  manifest.operators = mapObject(localized.operators, op => {
    const {
      category,
      name,
      index,
      ctu: unit,
      uniqueStatistic: {
        pvp: { statisticId: statId, label: statLabel }
      },
      mask,
      badge,
      figure: { large, small }
    } = op;
    const [unitOrder, unitId] = index.split(":").map(hex);
    // add the assets to the download list
    toDownload.push({
      url: large,
      local: `/operators/${op.id}/large.png`
    });
    toDownload.push({
      url: small,
      local: `/operators/${op.id}/small.png`
    });
    toDownload.push({
      url: mask,
      local: `/operators/${op.id}/mask.png`
    });
    toDownload.push({
      url: badge,
      local: `/operators/${op.id}/icon.png`
    });
    return {
      category: category === "atk" ? "attack" : "defend",
      name,
      unit,
      statId: statId.split(":")[0],
      statLabel,
      unitId,
      unitOrder,
      small: `/operators/${op.id}/small.png`,
      large: `/operators/${op.id}/large.png`,
      mask: `/operators/${op.id}/mask.png`,
      icon: `/operators/${op.id}/icon.png`
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
        local: `/seasons/s${id}/background.jpg`
      });
      return {
        name: season.name,
        background: `/seasons/s${id}/background.jpg`
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
        local: `/seasons/s${season.id}/ranks/r${id}/icon.svg`
      });
      range = range || { "0": 0, "1": 0 };
      const { "0": min, "1": max } = range;
      manifest.ranks[`s${season.id}-r${id}`] = {
        name,
        min,
        max,
        icon: `/seasons/s${season.id}/ranks/r${id}/icon.svg`
      };
    }
  }
  manifest.allRanks = Object.keys(manifest.ranks);
  manifest.allDivisions = Object.keys(manifest.divisions);
  fs.removeSync("./dist");
  fs.mkdirSync("./dist");
  debug("saving manifest to disk");
  fs.writeFileSync("./dist/manifest.json", JSON.stringify(manifest));
  fs.removeSync("./dist/assets");
  fs.mkdirSync("./dist/assets");

  // download all the assets
  debug("downloading assets");
  await batch(
    toDownload,
    downloadAs({
      localPath: "./dist/assets",
      baseUrl: "https://game-rainbow6.ubi.com"
    }),
    50
  );
  console.log(`Downloaded ${toDownload.length} items.`);

  fs.mkdirpSync("./docs/auto");

  // auto gen docs for the manifest
  // operators
  debug("generating docs content")
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
            season != manifest.allDivisions[index - 1].match(/s([0-9]+)-/)[1]
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
        .map((id, index) => {
          const rank = manifest.ranks[id];
          const season = id.match(/s([0-9]+)-/)[1];
          const prefix =
            index === 0 ||
            season != manifest.allRanks[index - 1].match(/s([0-9]+)-/)[1]
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

// functions extract operator information from a page
const operatorLayouts = {
  0: () => {},
  1: nameToId => {
    const getStat = s => {
      return parseInt(
        Array.from(
          document.getElementsByClassName(`op-rating ${s}`)[0].classList
        )
          .filter(c => c.startsWith("rating-rank-"))[0]
          .replace("rating-rank-", "")
      );
    };

    const name = document.getElementsByClassName("op-name")[0].innerText;
    const id = nameToId[name.toLowerCase()];
    const roles = document
      .getElementsByClassName("op-role")[0]
      .innerText.split(",")
      .map(s => s.trim());
    const armor = getStat("armor");
    const speed = getStat("speed");
    const difficulty = getStat("difficulty");
    const brief = document.getElementsByClassName("intro")[0].innerText;
    const loadout = Array.from(
      document.getElementsByClassName("op-loadout-section")
    )
      .map(section => {
        return {
          [section.getElementsByTagName("h3")[0].innerText]: Array.from(
            section.querySelectorAll(".item:not(.slick-cloned)")
          ).map(item => {
            return {
              name: item.querySelector(".op-weapon-name").innerText,
              image: item.querySelector("img").src,
              type: item.querySelector(".op-weapon-type").innerText || undefined
            };
          })
        };
      })
      .reduce((a, b) => Object.assign(a, b), {});
    document.getElementById("tab-op-identity").click();
    const bio = Array.from(document.querySelectorAll(".operator-bio-detail li"))
      .map(el => {
        return {
          [el.innerText.split(":")[0].toUpperCase()]: el.querySelector("span")
            .innerText
        };
      })
      .concat([
        {
          BACKGROUND: document
            .querySelector(".operator-bio-desc")
            .innerText.replace(
              document.querySelector(".operator-bio-desc strong").innerText,
              ""
            )
            .trim()
        }
      ])
      .reduce((a, b) => Object.assign(a, b), {});
    return [
      id,
      {
        roles,
        armor,
        speed,
        difficulty,
        brief,
        loadout,
        bio
      }
    ];
  },
  2: nameToId => {
    const getStat = s => {
      return parseInt(
        Array.from(document.querySelector(`.op-rating-${s}`).classList)
          .filter(c => c.startsWith("rating-rank-"))[0]
          .replace("rating-rank-", "")
      );
    };

    const name = document.querySelector(".operator-overview-side h3").innerText;
    const id = nameToId[name.toLowerCase()];
    const armor = getStat("armor");
    const speed = getStat("speed");
    const ability = document.querySelector(".operator-gadget span").innerText;

    const bio = Array.from(document.querySelectorAll(".operator-bio li"))
      .map(el => {
        return {
          [el.innerText.split(":")[0]]: el.querySelector("span").innerText
        };
      })
      .concat([
        {
          BACKGROUND: document.querySelector(".operator-bio p").innerText.trim()
        }
      ])
      .reduce((a, b) => Object.assign(a, b), {});

    return [
      id,
      {
        armor,
        speed,
        bio,
        ability
      }
    ];
  },
  3: nameToId => {
    const getStat = s => {
      return parseInt(
        Array.from(
          Array.from(document.querySelectorAll(".ratings li"))
            .filter(el => el.innerText.toLowerCase().trim() === s)[0]
            .querySelector("span").classList
        )
          .filter(c => c.startsWith("rating-rank-"))[0]
          .replace("rating-rank-", "")
      );
    };

    const name = document.querySelector(".operator-overview-side h3").innerText;
    const id = nameToId[name.toLowerCase()];
    const armor = getStat("armor");
    const speed = getStat("speed");
    const ability = document
      .querySelector(".operator-gadget h5")
      .innerText.replace(
        document.querySelector(".operator-gadget h5 span").innerText,
        ""
      )
      .trim();
    const brief = document.getElementsByClassName("intro")[0].innerText;
    const loadout = Array.from(
      document.getElementsByClassName("operator_loadout_primary")
    )
      .map(section => {
        return {
          [section.getElementsByTagName("h3")[0].innerText]: Array.from(
            section.querySelectorAll("li")
          ).map(item => {
            return {
              name: item.querySelector("span").innerText,
              image: item.querySelector("img").src
            };
          })
        };
      })
      .reduce((a, b) => Object.assign(a, b), {});
    const bio = document
      .querySelector(".operator-bio-desc")
      .innerText.split("\n")
      .filter(l => l !== "")
      .reduce(
        (joined, current) => {
          if (current === current.toUpperCase()) {
            joined[1] = current;
          } else {
            joined[0][joined[1]] = current;
          }
          return joined;
        },
        [{}, "QUOTE"]
      )[0];
    return [
      id,
      {
        armor,
        speed,
        ability,
        brief,
        loadout,
        bio
      }
    ];
  },
  4: nameToId => {
    const getStat = s => {
      return parseInt(
        Array.from(
          document.getElementsByClassName(`op-rating ${s}`)[0].classList
        )
          .filter(c => c.startsWith("rating-rank-"))[0]
          .replace("rating-rank-", "")
      );
    };

    const name = document.querySelector(".op-name").innerText;
    const id = nameToId[name.toLowerCase()];
    const roles = document
      .getElementsByClassName("op-role")[0]
      .innerText.split(",")
      .map(s => s.trim());
    const armor = getStat("armor");
    const speed = getStat("speed");
    const brief = document.getElementsByClassName("intro")[0].innerText;
    const loadout = Array.from(
      document.getElementsByClassName("op-loadout-section")
    )
      .map(section => {
        return {
          [section.getElementsByTagName("h3")[0].innerText]: Array.from(
            section.querySelectorAll(".item:not(.slick-cloned)")
          ).map(item => {
            return {
              name: item.querySelector(".op-weapon-name").innerText,
              image: item.querySelector("img").src,
              type: item.querySelector(".op-weapon-type").innerText || undefined
            };
          })
        };
      })
      .reduce((a, b) => Object.assign(a, b), {});
    const ability = loadout.GADGET.pop();
    const bio = document
      .querySelector(".operator-bio-desc")
      .innerText.split("\n")
      .filter(l => l !== "")
      .reduce(
        (joined, current) => {
          if (current === current.toUpperCase()) {
            joined[1] = current;
          } else {
            joined[0][joined[1]] = current;
          }
          return joined;
        },
        [{}, "QUOTE"]
      )[0];
    return [
      id,
      {
        roles,
        armor,
        speed,
        ability,
        brief,
        loadout,
        bio
      }
    ];
  },
  5: nameToId => {
    const getStat = s => {
      return parseInt(
        Array.from(document.querySelector(`.op-rating-${s}`).classList)
          .filter(c => c.startsWith("rating-rank-"))[0]
          .replace("rating-rank-", "")
      );
    };

    const name = document.querySelector(".operator-overview-side h3").innerText;
    const id = nameToId[name.toLowerCase()];
    const armor = getStat("armor");
    const speed = getStat("speed");
    const ability = document.querySelector(".operator-gadget span").innerText;

    const bio = Array.from(document.querySelectorAll(".operator-bio li"))
      .map(el => {
        return {
          [el.innerText.split(":")[0]]: el.querySelector("span").innerText
        };
      })
      .concat([
        {
          BACKGROUND: document.querySelector(".operator-bio p").innerText.trim()
        }
      ])
      .reduce((a, b) => Object.assign(a, b), {});

    return [
      id,
      {
        armor,
        speed,
        bio,
        ability
      }
    ];
  }
};

// TODO: need to download the images it finds

// determine which layout function is needed
const determineOperatorLayout = () => {
  if (document.getElementsByClassName("gadget-pt").length > 0) {
    return 2;
  } else if (document.getElementById("tab-op-identity")) {
    return 1;
  } else if (document.getElementsByClassName("slick-slide").length > 0) {
    return 4;
  } else if (document.getElementsByClassName("operator-bio-desc").length > 0) {
    return 3;
  } else if (document.getElementsByClassName("op-rating-armor").length > 0) {
    return 5;
  } else {
    return 0; // unknown layout
  }
};

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

// limit the length of a string
const limit = (str, n) => {
  return str.length > n ? str.slice(0, n - 4) + "..." : str;
};

// parse int as hex
const hex = i => {
  return parseInt(i, 16);
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

const reduceToObjectAsync = async (arr, f) => {
  let r = {};
  for (const el of arr) {
    const [key, val] = await f(el);
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
