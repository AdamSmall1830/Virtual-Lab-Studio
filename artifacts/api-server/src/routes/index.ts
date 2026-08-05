import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import projectsRouter from "./projects";
import agentsRouter from "./agents";
import templatesRouter from "./templates";
import runsRouter from "./runs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(projectsRouter);
router.use(agentsRouter);
router.use(templatesRouter);
router.use(runsRouter);

export default router;
