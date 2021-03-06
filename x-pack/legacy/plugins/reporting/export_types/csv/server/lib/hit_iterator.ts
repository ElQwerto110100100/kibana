/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { i18n } from '@kbn/i18n';
import { SearchParams, SearchResponse } from 'elasticsearch';
import { CancellationToken } from '../../../../../../../plugins/reporting/common';
import { LevelLogger } from '../../../../server/lib';
import { ScrollConfig } from '../../../../server/types';

async function parseResponse(request: SearchResponse<any>) {
  const response = await request;
  if (!response || !response._scroll_id) {
    throw new Error(
      i18n.translate('xpack.reporting.exportTypes.csv.hitIterator.expectedScrollIdErrorMessage', {
        defaultMessage: 'Expected {scrollId} in the following Elasticsearch response: {response}',
        values: { response: JSON.stringify(response), scrollId: '_scroll_id' },
      })
    );
  }

  if (!response.hits) {
    throw new Error(
      i18n.translate('xpack.reporting.exportTypes.csv.hitIterator.expectedHitsErrorMessage', {
        defaultMessage: 'Expected {hits} in the following Elasticsearch response: {response}',
        values: { response: JSON.stringify(response), hits: 'hits' },
      })
    );
  }

  return {
    scrollId: response._scroll_id,
    hits: response.hits.hits,
  };
}

export function createHitIterator(logger: LevelLogger) {
  return async function* hitIterator(
    scrollSettings: ScrollConfig,
    callEndpoint: Function,
    searchRequest: SearchParams,
    cancellationToken: CancellationToken
  ) {
    logger.debug('executing search request');
    function search(index: string | boolean | string[] | undefined, body: object) {
      return parseResponse(
        callEndpoint('search', {
          index,
          body,
          scroll: scrollSettings.duration,
          size: scrollSettings.size,
        })
      );
    }

    function scroll(scrollId: string | undefined) {
      logger.debug('executing scroll request');
      return parseResponse(
        callEndpoint('scroll', {
          scrollId,
          scroll: scrollSettings.duration,
        })
      );
    }

    function clearScroll(scrollId: string | undefined) {
      logger.debug('executing clearScroll request');
      return callEndpoint('clearScroll', {
        scrollId: [scrollId],
      });
    }

    try {
      let { scrollId, hits } = await search(searchRequest.index, searchRequest.body);
      try {
        while (hits && hits.length && !cancellationToken.isCancelled()) {
          for (const hit of hits) {
            yield hit;
          }

          ({ scrollId, hits } = await scroll(scrollId));

          if (cancellationToken.isCancelled()) {
            logger.warning(
              'Any remaining scrolling searches have been cancelled by the cancellation token.'
            );
          }
        }
      } finally {
        await clearScroll(scrollId);
      }
    } catch (err) {
      logger.error(err);
      throw err;
    }
  };
}
