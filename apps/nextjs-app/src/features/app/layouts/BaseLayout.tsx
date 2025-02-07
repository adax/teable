import type { DriverClient } from '@teable/core';
import type { IGetBaseVo, ITableVo } from '@teable/openapi';
import { NotificationProvider, SessionProvider } from '@teable/sdk';
import type { IUser } from '@teable/sdk';
import { AnchorContext, AppProvider, BaseProvider, TableProvider } from '@teable/sdk/context';
import { useRouter } from 'next/router';
import React, { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/features/app/layouts';
import { BaseSideBar } from '../blocks/base/base-side-bar/BaseSideBar';
import { BaseSidebarHeaderLeft } from '../blocks/base/base-side-bar/BaseSidebarHeaderLeft';
import { BasePermissionListener } from '../blocks/base/BasePermissionListener';
import { Sidebar } from '../components/sidebar/Sidebar';
import { SideBarFooter } from '../components/SideBarFooter';
import { useSdkLocale } from '../hooks/useSdkLocale';

export const BaseLayout: React.FC<{
  children: React.ReactNode;
  tableServerData: ITableVo[];
  baseServerData: IGetBaseVo;
  driver?: DriverClient;
  user?: IUser;
}> = ({ children, tableServerData, baseServerData, driver, user }) => {
  const router = useRouter();
  const { baseId, tableId, viewId } = router.query;
  const sdkLocale = useSdkLocale();
  const { i18n } = useTranslation();

  return (
    <AppLayout>
      <AppProvider lang={i18n.language} locale={sdkLocale} driver={driver as DriverClient}>
        <SessionProvider user={user}>
          <NotificationProvider>
            <AnchorContext.Provider
              value={{
                baseId: baseId as string,
                tableId: tableId as string,
                viewId: viewId as string,
              }}
            >
              <BaseProvider serverData={baseServerData}>
                <BasePermissionListener />
                <TableProvider serverData={tableServerData}>
                  <div id="portal" className="relative flex h-screen w-full items-start">
                    <Sidebar headerLeft={<BaseSidebarHeaderLeft />}>
                      <Fragment>
                        <div className="flex flex-col gap-2 divide-y divide-solid overflow-auto py-2">
                          <BaseSideBar />
                        </div>
                        <div className="grow basis-0" />
                        <SideBarFooter />
                      </Fragment>
                    </Sidebar>
                    {children}
                  </div>
                </TableProvider>
              </BaseProvider>
            </AnchorContext.Provider>
          </NotificationProvider>
        </SessionProvider>
      </AppProvider>
    </AppLayout>
  );
};
