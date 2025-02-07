import type { IHttpError } from '@teable/core';
import type { ReactElement } from 'react';
import { Design } from '@/features/app/blocks/design/Design';
import { BaseLayout } from '@/features/app/layouts/BaseLayout';
import { tableConfig } from '@/features/i18n/table.config';
import type { IDesignPageProps } from '@/lib/design-pages-data';
import { getDesignPageServerData } from '@/lib/design-pages-data';
import { getTranslationsProps } from '@/lib/i18n';
import type { NextPageWithLayout } from '@/lib/type';
import type { IViewPageProps } from '@/lib/view-pages-data';
import withAuthSSR from '@/lib/withAuthSSR';

const Node: NextPageWithLayout<IDesignPageProps> = (props) => {
  return <Design {...props} />;
};

export const getServerSideProps = withAuthSSR<IDesignPageProps>(async (context, ssrApi) => {
  const { tableId, baseId } = context.query;
  try {
    const pageData = await getDesignPageServerData(ssrApi, baseId as string, tableId as string);
    if (pageData) {
      const { i18nNamespaces } = tableConfig;
      return {
        props: {
          ...pageData,
          ...(await getTranslationsProps(context, i18nNamespaces)),
        },
      };
    }
    return {
      notFound: true,
    };
  } catch (e) {
    const error = e as IHttpError;
    if (error.status < 500) {
      return {
        notFound: true,
      };
    }
    console.error(error);
    throw error;
  }
});

Node.getLayout = function getLayout(page: ReactElement, pageProps: IViewPageProps) {
  return <BaseLayout {...pageProps}>{page}</BaseLayout>;
};

export default Node;
