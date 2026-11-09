import { Module } from '@nestjs/common';
import { ChartService } from './chart.service';
import { CompareService } from './compare.service';
import { DatasetQueryService } from './dataset-query.service';
import { ForecastService } from './forecast.service';
import { ReportService } from './report.service';
import { DatasetsController } from './datasets.controller';
import { DatasetsService } from './datasets.service';
import { InternalDatasetsController } from './internal-datasets.controller';

@Module({
  controllers: [DatasetsController, InternalDatasetsController],
  providers: [
    DatasetsService,
    DatasetQueryService,
    ChartService,
    ForecastService,
    CompareService,
    ReportService,
  ],
  exports: [ChartService, ReportService],
})
export class DatasetsModule {}
