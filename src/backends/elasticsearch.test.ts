import { Elasticsearch } from "./elasticsearch"
import { Query } from "../services/query"
import { Now, Time } from "../helpers/time"

const prefix = 'https://es-server'
const index = "my-index"

describe('elasticsearch', () => {
  let es: Elasticsearch
  const docId = "docid"
  const docShort = {
    _source: {hello: "12345"},
    _index: index,
    _id: docId,
  }
  const docExpanded = {
    ...docShort,
    _source: {
      ...docShort._source,
      exception: "oh noes",
    }
  }

  beforeEach(() => {
    fetchMock.resetMocks()
    es = new Elasticsearch(prefix, index)
  })

  test('loadDocument', done => {
    fetchMock.mockResponseOnce(JSON.stringify(docShort))

    es.loadDocument(index, docId).then(data => {
      expect(data).toEqual({
        hello: "12345",
        _index: index,
        _id: docId,
        __cursor: {
          searchAfter: 0,
          id: docId,
        }
      })
      done()
    }).catch(e => console.log(e))
    expect(fetchMock.mock.calls.length).toEqual(1)
    expect(fetchMock.mock.calls[0][0]).toEqual(prefix + "/my-index/_doc/docid")
  })

  test('historicSearch', done => {
    const hits = {
      hits: {
        hits: [docShort]
      },
    }
    fetchMock
    // _search response
      .once(JSON.stringify(hits))
      // _mget response
      .once(JSON.stringify({
        docs: [docExpanded],
      }))

    const query = new Query(
      "crashy mccrashface",
      5,
      Time.wrapRelative(-1, "w"),
      Now,
      [],
    )

    es.historicSearch(query).then(data => {
      expect(fetchMock.mock.calls.length).toEqual(2)

      // expected _search request
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        "_source": [
          "@timestamp", "message", "level", "logger", "thread", "container", "service"
        ],
        "docvalue_fields": [{"field": "@timestamp", "format": "date_time"}],
        "query": {
          "bool": {
            "must": [
              {
                "query_string": {
                  "analyze_wildcard": true,
                  "default_field": "message",
                  "default_operator": "AND",
                  "fuzziness": 0,
                  "query": "crashy mccrashface"
                }
              }, {
                "range": {
                  "@timestamp": {
                    "format": "strict_date_optional_time",
                    "gte": "now-1w",
                    "lte": "now"
                  }
                }
              }
            ]
          }
        },
        "size": 5,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "timeout": "30000ms"
      })

      // expected _mget request
      expect(fetchMock.mock.calls[1][1].body).toEqual(JSON.stringify({
        docs: [{_id: docId}]
      }))

      // _full is a promise, so we extract it out and resolve it after an assertion
      const {_full, ...overview} = data.overview[0]
      const expectedShort = {
        __cursor: {
          "id": "docid",
          "searchAfter": 0,
        },
        _id: "docid",
        _index: "my-index",
        "hello": "12345",
      }
      expect(overview).toEqual(expectedShort)

      _full.then(d => {
        expect(d).toEqual({
          ...expectedShort,
          "exception": "oh noes",
        })

        done()
      })
    }).catch(e => console.log(e))
  })
})
