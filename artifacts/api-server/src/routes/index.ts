import { Router, type IRouter } from "express";
import healthRouter from "./health";
import spotifyRouter from "./spotify";
import spotifyAuthRouter from "./spotifyAuth";
import downloadRouter from "./download";

const router: IRouter = Router();

router.use(healthRouter);
router.use(spotifyRouter);
router.use(spotifyAuthRouter);
router.use(downloadRouter);

export default router;
