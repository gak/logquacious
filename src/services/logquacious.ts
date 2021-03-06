import { Results } from "./results"
import { Loading } from "./loading"
import { Elasticsearch, IDataSource, Result } from "../backends/elasticsearch"
import { Query } from "./query"
import { Histogram } from "./histogram"
import { Display, DisplayCallback, Filter } from "../components/app"
import { Direction, Prefs, Theme } from "./prefs"
import { ThemeChanger } from "./themeChanger"
import { Range } from "../helpers/time"
import { FieldsConfig } from "./log"

export type QueryCallback = (q: Query) => void
export type ThemeCallback = (theme: Theme) => void
export type FilterCallback = (filters: Filter[]) => void
export type DirectionCallback = (direction: Direction) => void

export enum DataSourceType {
  ElasticSearch = "elasticsearch"
}

export type DataSourceConfig = {
  id: string
  type: DataSourceType
  urlPrefix: string
  index: string
  fields: string
}

export interface ITracker {
  trackSearch(q: Query)
}

export type Config = {
  dataSources: DataSourceConfig[]
  fields: { [key: string]: FieldsConfig }
  filters: Filter[]
  tracker?: ITracker
}

export class Logquacious {
  config: Config
  prefs: Prefs
  results: Results
  dataSources: Map<string, IDataSource>
  loading: Loading
  query: Query
  histogram: Histogram
  focusInput: boolean = true
  themeChanger: ThemeChanger

  private onQuery: QueryCallback
  private onDisplay: DisplayCallback
  private onFilter: FilterCallback
  private onTheme: ThemeCallback
  private onDirection: DirectionCallback
  private errorToDisplay: any

  constructor(config: Config) {
    this.config = config
    if (!this.config) {
      this.error("config is invalid")
    }
  }

  run(resultsElement: HTMLElement, histogramElement: SVGElement) {
    this.logo()

    this.query = Query.fromURL(this.config.filters)
    this.onQuery(this.query)
    this.onFilter(this.config.filters)

    this.prefs = new Prefs().load()
    this.onTheme(this.prefs.theme)
    this.onDirection(this.prefs.direction)

    this.loading = new Loading()

    this.dataSources = new Map<string, IDataSource>()
    for (const ds of this.config.dataSources) {
      // We only currently support elasticsearch
      this.dataSources.set(ds.id, new Elasticsearch(ds.urlPrefix, ds.index))
    }

    this.results = new Results(this.prefs.direction)
    let fieldsConfig = this.config.fields[this.dsConfig().fields]
    if (!fieldsConfig) {
      this.error(`dataSource field reference is invalid.\ndataSource.fields=${this.dsConfig().fields}`)
    }
    this.results.attach(resultsElement, fieldsConfig)

    this.focusInput = true

    this.histogram = new Histogram(this.ds(), this.prefs.data.direction)
    this.histogram.attach(histogramElement)
    this.histogram.setCallback((q) => this.newSearch(q, true, false))

    this.themeChanger = new ThemeChanger()
    this.themeChanger.setTheme(this.prefs.theme)

    window.onpopstate = () => {
      let q = Query.fromURL(this.config.filters)
      if (!q.equals(this.query)) {
        this.onQuery(q)
        this.newSearch(q)
      }
    }

    let empty = this.query.isEmpty()
    if (!empty) {
      this.search(this.query, false, false)
    }

    this.results.setMarkerCallback(true, () => {
      this.searchBackwards()
    })
    this.results.setMarkerCallback(false, () => {
      this.searchForwards()
    })

    setInterval(() => {
      if (this.histogram == undefined) {
        return
      }
      this.histogram.setDownloadedRange(this.results.getRange())
      this.histogram.setVisibleRange(this.results.getVisibleRange())
    }, 100)
  }

  dsConfig(): DataSourceConfig {
    let id: string
    if (this.config.dataSources.length == 1) {
      return this.config.dataSources[0]
    } else {
      id = this.query.selectedDataSource()
      if (!id) {
        this.error("No data source selected. You need to create a filter to switch between them.")
        return undefined
      }

      return this.config.dataSources.find(ds => ds.id == id)
    }
  }

  ds(): IDataSource {
    const dsConfig = this.dsConfig()
    try {
      const ds = this.dataSources.get(dsConfig.id)
      if (!ds) {
        this.error(`Data source not found for ${dsConfig.id}`)
        return undefined
      }
      return ds

    } catch (e) {
      this.error(e)
    }
    return undefined
  }

  // Called when the user presses enter, clicks on search, or on load.
  newSearch(q: Query, pushHistory?: boolean, inputFocus: boolean = true) {
    this.query = q
    document.title = q.title()
    if (pushHistory) {
      history.pushState(null, q.title(), "?" + q.toURL())
    }
    this.search(q, false, false, inputFocus)
  }

  public async search(query: Query, nextPage: boolean, nextPageOlder?: boolean, inputFocus: boolean = true) {
    this.trackSearch(query)
    this.showLogs()

    if (this.histogram != undefined) {
      this.histogram.search(query).catch(reason => {
        this.loading.deactivate()
        this.error(reason)
      })
    }

    this.query = query
    this.focusInput = inputFocus

    if (!nextPage) {
      this.results.fieldsConfig = this.config.fields[this.dsConfig().fields]
      this.results.clear()
    }
    this.loading.activate()
    let logs: Result

    if (nextPage) {
      this.results.updateMoreMarker(nextPageOlder, true)
    }

    try {
      if (nextPage && this.results.stats.visible > 0) {
        const cursor = this.results.getCursor(nextPageOlder)
        logs = await this.ds().historicSearch(query, cursor, !nextPageOlder)
      } else {
        logs = await this.ds().historicSearch(query)
      }
    } catch (reason) {
      this.loading.deactivate()
      this.error(reason)
      return
    }

    // Deactivate progress bar once the background load completes.
    logs.full.then(() => this.loading.deactivate(), () => this.loading.deactivate())

    if (nextPage) {
      this.results.saveScroll(nextPageOlder)
    }

    await this.staggerAppend(logs.overview, query, nextPage, nextPageOlder)

    this.results.updateMoreMarker(true, false)
    this.results.updateMoreMarker(false, false)

    if (nextPage) {
      // Keep the apparent scroll position when inserting dom elements above.
      this.results.restoreScroll(nextPageOlder)
    } else {
      // Scroll to latest after all the results are in, only on first page load.
      this.results.scrollToLatest()
    }
  }

  // Append the results in chunks so that we never block browser UI rendering for too long.
  private staggerAppend(logs: any, query: Query, nextPage: boolean, nextPageOlder: boolean): Promise<void> {
    return new Promise(resolve => {
      let idx = 0
      let chunkSize = 50
      let length = logs.length
      if (nextPage && nextPageOlder) {
        logs.reverse()
      }
      const that = this
      const hrefMaker = (term: string) => query.withTerm(term).toURL()

      function renderChunk() {
        let chunkEnd = idx + chunkSize
        if (chunkEnd > length) {
          chunkEnd = length
        }
        for (; idx < chunkEnd; idx++) {
          if (nextPage && nextPageOlder) {
            that.results.prepend(logs[idx], hrefMaker)
          } else {
            that.results.append(logs[idx], hrefMaker)
          }
        }
        if (chunkEnd === length) {
          resolve()
          return
        }
        resolve()
        requestAnimationFrame(renderChunk)
      }

      renderChunk()
    })
  }

  searchBackwards() {
    this.search(this.query, true, true)
  }

  searchForwards() {
    this.search(this.query, true, false)
  }

  set queryCallback(callback: QueryCallback) {
    this.onQuery = callback
  }

  handleSearchBarCallback(text: string, submit: boolean) {
    this.query = this.query.replaceText(text)
    if (submit) {
      this.newSearch(this.query, true)
    }
    this.onQuery(this.query)
  }

  handleFilterChanged(filter: string, selected: string) {
    this.config.filters = this.config.filters.map(f => f.id === filter ? {...f, selected} : f)
    this.query = this.query.withFilter(filter, selected)
    this.newSearch(this.query, true)
    this.onFilter(this.config.filters)
    this.onQuery(this.query)
  }

  handleRangeCallback(range: Range) {
    this.query = this.query.withTimeRange(range)
    this.newSearch(this.query, true)
    this.onQuery(this.query)
  }

  set filterCallback(callback: FilterCallback) {
    this.onFilter = callback
  }

  set themeCallback(callback: ThemeCallback) {
    this.onTheme = callback
  }

  handleThemeCallback(theme: Theme) {
    this.prefs.theme = theme
    this.prefs.save()
    this.themeChanger.setTheme(theme)
    this.onTheme(theme)
  }

  set directionCallback(callback: DirectionCallback) {
    this.onDirection = callback
  }

  handleDirectionCallback(direction: Direction) {
    this.prefs.direction = direction
    this.prefs.save()
    this.results.setDirection(direction)
    this.histogram.setDirection(direction)
    this.onDirection(direction)
  }

  set displayCallback(callback: DisplayCallback) {
    this.onDisplay = callback

    // Sometimes an error can happen before this callback is set.
    if (this.errorToDisplay) {
      this.error(this.errorToDisplay)
      this.errorToDisplay = null
    }
  }

  showLogs() {
    this.onDisplay(Display.logs)
  }

  showWelcome() {
    this.onDisplay(Display.welcome)
  }

  error(error) {
    console.error(error)

    if (!this.onDisplay) {
      this.errorToDisplay = error
      return
    }

    let message = ""
    if (error !== null) {
      if (error.name !== undefined) {
        message += error.name + "\n"
      }
      if (error.message !== undefined) {
        message += error.message + "\n"
      }
      if (error.stack !== undefined) {
        message += error.stack + "\n"
      }
      if (message == "") {
        message = JSON.stringify(error)
      }
    } else {
      message = "Sorry, we got a null error somehow."
    }

    this.onDisplay(Display.error, message)
  }

  private trackSearch(query: Query) {
    if (!this.config.tracker) {
      return
    }

    this.config.tracker.trackSearch(query)
  }

  private logo() {
    // Don't print when testing.
    if (process.env.JEST_WORKER_ID === undefined) {
      console.log("%c\n\
                                           \n\
    /)                       ,             \n\
   // ____   _       _   _     ___    _    \n\
  (/_(_)(_/_(_/_(_(_(_(_(___(_(_)(_(_/_)_  \n\
       .-/   /(                            \n\
      (_/   (_)    Super fast logs...      \n\
                                           \n\
                                           \n",
        'background: #123456; color: #ffffff')
    }
  }
}
