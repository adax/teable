import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ILinkCellValue, ILinkFieldOptions, ITinyRecord } from '@teable-group/core';
import {
  Relationship,
  RelationshipRevert,
  FieldType,
  generateRecordId,
  RecordOpBuilder,
} from '@teable-group/core';
import type { Prisma } from '@teable-group/db-main-prisma';
import type { Connection } from '@teable/sharedb/lib/client';
import { isEqual } from 'lodash';
import type { IRawOpMap } from '../../../share-db/interface';
import { FieldCalculationService } from '../../calculation/field-calculation.service';
import type { IOpsMap } from '../../calculation/reference.service';
import { FieldSupplementService } from '../field-supplement.service';
import type { IFieldInstance } from '../model/factory';
import {
  createFieldInstanceByVo,
  createFieldInstanceByRaw,
  rawField2FieldObj,
} from '../model/factory';
import type { LinkFieldDto } from '../model/field-dto/link-field.dto';
import { FieldCreatingService } from './field-creating.service';
import { FieldDeletingService } from './field-deleting.service';

@Injectable()
export class FieldConvertingLinkService {
  constructor(
    private readonly fieldDeletingService: FieldDeletingService,
    private readonly fieldCreatingService: FieldCreatingService,
    private readonly fieldSupplementService: FieldSupplementService,
    private readonly fieldCalculationService: FieldCalculationService
  ) {}

  private async generateSymmetricFieldChange(
    prisma: Prisma.TransactionClient,
    linkField: LinkFieldDto
  ) {
    const fieldRaw = await prisma.field.findFirstOrThrow({
      where: { id: linkField.options.symmetricFieldId, deletedTime: null },
    });
    const oldField = createFieldInstanceByRaw(fieldRaw);
    const newFieldVo = rawField2FieldObj(fieldRaw);

    const options = newFieldVo.options as ILinkFieldOptions;
    options.relationship = RelationshipRevert[linkField.options.relationship];
    options.dbForeignKeyName = linkField.options.dbForeignKeyName;
    newFieldVo.isMultipleCellValue = options.relationship !== Relationship.ManyOne || undefined;

    return {
      tableId: linkField.options.foreignTableId,
      newField: createFieldInstanceByVo(newFieldVo),
      oldField,
    };
  }

  private async linkOptionsChange(
    prisma: Prisma.TransactionClient,
    connection: Connection,
    tableId: string,
    newField: LinkFieldDto,
    oldField: LinkFieldDto
  ) {
    if (
      newField.options.foreignTableId === oldField.options.foreignTableId &&
      newField.options.relationship === oldField.options.relationship
    ) {
      throw new Error('only support modify link foreignTableId or relationship');
    }

    if (newField.options.foreignTableId !== oldField.options.foreignTableId) {
      // update current field reference
      await prisma.reference.deleteMany({
        where: {
          toFieldId: newField.id,
        },
      });
      await this.fieldSupplementService.createReference(prisma, newField);
      await this.fieldSupplementService.cleanForeignKey(prisma, tableId, oldField.options);
      // create new symmetric link
      await this.fieldSupplementService.createForeignKey(prisma, tableId, newField);
      const symmetricField = await this.fieldSupplementService.generateSymmetricField(
        prisma,
        tableId,
        newField
      );
      const createResult = await this.fieldCreatingService.createAndCalculate(
        connection,
        prisma,
        newField.options.foreignTableId,
        symmetricField
      );

      // delete old symmetric link
      const deleteResult = await this.fieldDeletingService.delateAndCleanRef(
        prisma,
        connection,
        oldField.options.foreignTableId,
        oldField.options.symmetricFieldId,
        true
      );
      return {
        rawOpMaps: [createResult.rawOpsMap, deleteResult.rawOpsMap].filter(Boolean) as IRawOpMap[],
      };
    }

    if (newField.options.relationship !== oldField.options.relationship) {
      await this.fieldSupplementService.cleanForeignKey(prisma, tableId, oldField.options);
      // create new symmetric link
      await this.fieldSupplementService.createForeignKey(prisma, tableId, newField);
      const rawOpsMap = await this.fieldDeletingService.cleanField(
        prisma,
        connection,
        newField.options.foreignTableId,
        [newField.options.symmetricFieldId]
      );
      const fieldChange = await this.generateSymmetricFieldChange(prisma, newField);

      return {
        rawOpMaps: rawOpsMap && [rawOpsMap],
        fieldChange,
      };
    }
  }

  private async otherToLink(
    prisma: Prisma.TransactionClient,
    connection: Connection,
    tableId: string,
    newField: LinkFieldDto
  ) {
    await this.fieldSupplementService.createForeignKey(prisma, tableId, newField);
    const symmetricField = await this.fieldSupplementService.generateSymmetricField(
      prisma,
      tableId,
      newField
    );
    await this.fieldSupplementService.createReference(prisma, newField);
    const symmetricResult = await this.fieldCreatingService.createAndCalculate(
      connection,
      prisma,
      newField.options.foreignTableId,
      symmetricField
    );
    return {
      rawOpMaps: symmetricResult.rawOpsMap && [symmetricResult.rawOpsMap],
    };
  }

  private async linkToOther(
    prisma: Prisma.TransactionClient,
    connection: Connection,
    tableId: string,
    oldField: LinkFieldDto
  ) {
    const deleteResult = await this.fieldDeletingService.delateAndCleanRef(
      prisma,
      connection,
      oldField.options.foreignTableId,
      oldField.options.symmetricFieldId,
      true
    );
    return {
      rawOpMaps: deleteResult.rawOpsMap && [deleteResult.rawOpsMap],
    };
  }

  /**
   * 1. switch link table
   * 2. other field to link field
   * 3. link field to other field
   */
  async supplementLink(
    prisma: Prisma.TransactionClient,
    connection: Connection,
    tableId: string,
    newField: IFieldInstance,
    oldField: IFieldInstance
  ): Promise<
    | {
        rawOpMaps?: IRawOpMap[];
        fieldChange?: { tableId: string; newField: IFieldInstance; oldField: IFieldInstance };
      }
    | undefined
  > {
    if (
      newField.type === FieldType.Link &&
      oldField.type === FieldType.Link &&
      !isEqual(newField.options, oldField.options)
    ) {
      return this.linkOptionsChange(prisma, connection, tableId, newField, oldField);
    }

    if (newField.type !== FieldType.Link && oldField.type === FieldType.Link) {
      return this.linkToOther(prisma, connection, tableId, oldField);
    }

    if (newField.type === FieldType.Link && oldField.type !== FieldType.Link) {
      return this.otherToLink(prisma, connection, tableId, newField);
    }
  }

  private async getRecords(
    prisma: Prisma.TransactionClient,
    tableId: string,
    field: IFieldInstance
  ) {
    const { dbTableName } = await prisma.tableMeta.findFirstOrThrow({
      where: { id: tableId },
      select: { dbTableName: true },
    });

    const result = await this.fieldCalculationService.getRecordsBatchByFields(prisma, {
      [dbTableName]: [field],
    });
    const records = result[dbTableName];
    if (!records) {
      throw new InternalServerErrorException(
        `Can't find recordMap for tableId: ${tableId} and fieldId: ${field.id}`
      );
    }

    return records;
  }

  // TODO: how to handle consistency of one-many ? Same value should not be select in a multiple cell value field.
  /**
   * convert oldCellValue to new link field cellValue
   * if oldCellValue is not in foreignTable, create new record in foreignTable
   */
  async convertLink(
    prisma: Prisma.TransactionClient,
    tableId: string,
    newField: LinkFieldDto,
    oldField: IFieldInstance
  ) {
    const fieldId = newField.id;
    const foreignTableId = newField.options.foreignTableId;
    const lookupFieldRaw = await prisma.field.findFirstOrThrow({
      where: { id: newField.options.lookupFieldId, deletedTime: null },
    });
    const lookupField = createFieldInstanceByRaw(lookupFieldRaw);

    const records = await this.getRecords(prisma, tableId, oldField);
    const foreignRecords = await this.getRecords(prisma, foreignTableId, lookupField);

    const primaryNameToIdMap = foreignRecords.reduce<{ [name: string]: string }>((pre, record) => {
      const str = lookupField.cellValue2String(record.fields[lookupField.id]);
      pre[str] = record.id;
      return pre;
    }, {});

    const recordOpsMap: IOpsMap = { [tableId]: {}, [foreignTableId]: {} };
    const recordsForCreate: { [title: string]: ITinyRecord } = {};
    // eslint-disable-next-line sonarjs/cognitive-complexity
    records.forEach((record) => {
      const oldCellValue = record.fields[fieldId];
      if (oldCellValue == null) {
        return;
      }
      let newCellValueTitle: string[];
      if (newField.isMultipleCellValue) {
        newCellValueTitle = oldField.isMultipleCellValue
          ? (oldCellValue as unknown[]).map((item) => oldField.item2String(item))
          : oldField.item2String(oldCellValue).split(', ');
      } else {
        newCellValueTitle = oldField.isMultipleCellValue
          ? [oldField.item2String((oldCellValue as unknown[])[0])]
          : [oldField.item2String(oldCellValue).split(', ')[0]];
      }

      const newCellValue: ILinkCellValue[] = [];

      newCellValueTitle.forEach((title) => {
        if (primaryNameToIdMap[title]) {
          newCellValue.push({ id: primaryNameToIdMap[title], title });
          return;
        }

        // do not create record if lookup field is computed
        if (lookupField.isComputed) {
          return;
        }

        const cv = lookupField.convertStringToCellValue(title);

        // do not create record if title string in lookup field is not valid
        if (cv == null) {
          return;
        }

        // convert cv back to string make sure it display well
        // example: '1.03' convertStringToCellValue 1.0 cellValue2String '1.0'
        title = lookupField.cellValue2String(cv);

        if (!recordsForCreate[title]) {
          const newRecordId = generateRecordId();
          recordsForCreate[title] = {
            id: newRecordId,
            fields: {
              [lookupField.id]: cv,
            },
          };
        }
        newCellValue.push({ id: recordsForCreate[title].id, title });
      });

      if (!recordOpsMap[tableId][record.id]) {
        recordOpsMap[tableId][record.id] = [];
      }
      recordOpsMap[tableId][record.id].push(
        RecordOpBuilder.editor.setRecord.build({
          fieldId,
          newCellValue: newField.isMultipleCellValue ? newCellValue : newCellValue[0],
          oldCellValue,
        })
      );
    });

    return {
      recordOpsMap,
      recordsForCreate: { [foreignTableId]: recordsForCreate },
    };
  }
}