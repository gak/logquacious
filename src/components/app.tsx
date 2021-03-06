import { Component, Fragment } from "inferno"
import { Logs } from "./logs"
import { Range } from "../helpers/time"
import { AttachHistogramCallback, Histogram } from "./histogram"
import { Logquacious } from "../services/logquacious"
import { Query } from "../services/query"
import { ChangeFilterCallback, FilterDropdown, FilterItem } from "./filterDropdown"
import { ChangeSettingCallback, MenuSetting } from "./menuSetting"
import { Direction, Theme } from "../services/prefs"
import { Welcome } from "./welcome"
import { Error } from "./error"
import { Title } from "./title"
import { SearchBar, SearchBarCallback } from "./searchBar"
import { Menu } from "./menu"
import { ChangeRangeCallback, Picker } from "./picker/picker"

export type AttachResultsCallback = (el: HTMLElement) => void
export type DisplayCallback = (d: Display, errorMessage?: string) => void

export enum Display {
  logs,
  welcome,
  error,
}

export enum FilterType {
  dataSource,
  singleValue,
}

interface Props {
  log: Logquacious
}

interface State {
  display: Display
  theme: Theme
  direction: Direction
  filters: Filter[]
  errorMessage?: string
  query: Query,
  focusInput: boolean,
}

export type Filter = {
  id: string
  title: string
  selected?: string
  default: string
  items: FilterItem[]
  type: FilterType
  urlKey: string
}

export class App extends Component<Props, State> {
  private log: Logquacious
  private resultsElement: HTMLElement
  private histogramElement: SVGElement

  constructor(props) {
    super(props)

    this.log = this.props.log

    this.state = {
      filters: [],
      theme: Theme.Light,
      direction: Direction.Up,
      display: Display.welcome,
      query: Query.Default(),
      focusInput: true,
    }
  }

  componentDidMount(): void {
    this.log.displayCallback = (display: Display, errorMessage?: string) => this.setState({display, errorMessage})
    this.log.filterCallback = (filters: Filter[]) => this.setState({filters})
    this.log.themeCallback = (theme: Theme) => this.setState({theme})
    this.log.directionCallback = (direction: Direction) => this.setState({direction})
    this.log.queryCallback = (query: Query) => this.setState({query})
    this.log.run(this.resultsElement, this.histogramElement)
  }

  handleAttachResults: AttachResultsCallback = (el: HTMLElement) => this.resultsElement = el
  handleAttachHistogram: AttachHistogramCallback = (el: SVGElement) => this.histogramElement = el

  handleSearchBarCallback: SearchBarCallback = (text, submit) => this.log.handleSearchBarCallback(text, submit)
  handleTimeRangeChanged: ChangeRangeCallback = (range: Range) => this.log.handleRangeCallback(range)
  handleFilterChanged: ChangeFilterCallback = (filter: string, selected: string) => this.log.handleFilterChanged(filter, selected)

  handleThemeChanged: ChangeSettingCallback<Theme> = (theme: Theme) => this.log.handleThemeCallback(theme)
  handleDirectionChanged: ChangeSettingCallback<Direction> = (direction: Direction) => this.log.handleDirectionCallback(direction)

  render() {
    const range: Range = [this.state.query.startTime, this.state.query.endTime]
    return (
      <Fragment>
        <Histogram onAttachHistogram={this.handleAttachHistogram}/>
        <nav class="navbar is-fixed-top log-nav">
          <Title/>
          <SearchBar
            focusInput={this.state.focusInput}
            queryText={this.state.query.q}
            onQueryText={this.handleSearchBarCallback}
          />

          <FilterDropdown filters={this.state.filters} onChange={this.handleFilterChanged}/>

          <Picker
            range={range}
            onChange={this.handleTimeRangeChanged}
          />

          <Menu.Dropdown title="Menu" isActive="auto">
            <Menu.Title>Settings</Menu.Title>
            <MenuSetting
              onChange={this.handleThemeChanged}
              setting="theme"
              value={this.state.theme}
              title="Theme"
              on={{title: "Dark", value: Theme.Dark}}
              off={{title: "Light", value: Theme.Light}}
            />
            <MenuSetting
              onChange={this.handleDirectionChanged}
              setting="direction"
              value={this.state.direction}
              title="Direction"
              on={{title: "Up", value: Direction.Up}}
              off={{title: "Down", value: Direction.Down}}
            />
          </Menu.Dropdown>

          <div id="stats-area" class="log-stats"/>
          <progress id="loading" class="progress is-info log-progress"/>
        </nav>

        <Logs visible={this.state.display == Display.logs} onAttachResults={this.handleAttachResults}/>
        <Welcome visible={this.state.display == Display.welcome}/>
        <Error visible={this.state.display == Display.error} message={this.state.errorMessage}/>

        <textarea id="copy-helper"/>
      </Fragment>
    )
  }
}